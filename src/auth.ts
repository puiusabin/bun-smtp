/**
 * SASL authentication handlers.
 *
 * Each exported function matches the signature:
 *   (ctx: ConnectionContext, args: string[], done: () => void) => void
 *
 * They set ctx.nextHandler for multi-step exchanges and call the server's
 * onAuth hook at the right moment.
 */

import { CryptoHasher } from "bun";
import type { ConnectionContext } from "./types.ts";
import type { AuthObjectCramMd5 } from "./types.ts";

type AuthHandler = (ctx: ConnectionContext, args: string[], done: () => void) => void;

// ---- Helpers ---------------------------------------------------------------

function decodeB64(s: string): string {
  return Buffer.from(s.trim(), "base64").toString();
}

function sendAuthSuccess(ctx: ConnectionContext, user: unknown): void {
  ctx.session.user = user;
  ctx.session.transmissionType = computeTransmissionType(ctx);
  sendRaw(ctx, "235 2.7.0 Authentication successful\r\n");
}

function sendRaw(ctx: ConnectionContext, line: string): void {
  ctx.socket.write(line);
}

function sendCode(ctx: ConnectionContext, code: number, msg: string): void {
  sendRaw(ctx, `${code} ${msg}\r\n`);
}

/** Mirrors smtp-connection._transmissionType() */
export function computeTransmissionType(ctx: ConnectionContext): string {
  let type = ctx.server.options.lmtp ? "LMTP" : "SMTP";
  if (ctx.openingCommand === "EHLO" || ctx.openingCommand === "LHLO") {
    type = "E" + type;
  }
  if (ctx.secure) type += "S";
  if (ctx.session.user) type += "A";
  return type;
}

// ---- PLAIN -----------------------------------------------------------------

export const SASL_PLAIN: AuthHandler = (ctx, args, done) => {
  if (args.length > 1) {
    sendCode(ctx, 501, "Error: syntax: AUTH PLAIN token");
    return done();
  }

  if (args.length === 0) {
    ctx.nextHandler = (token, next) => plainToken(ctx, true, token, next);
    sendRaw(ctx, "334 \r\n");
    return done();
  }

  plainToken(ctx, false, args[0]!, done);
};

function plainToken(ctx: ConnectionContext, canAbort: boolean, token: string, done: () => void): void {
  token = token.trim();

  if (canAbort && token === "*") {
    sendCode(ctx, 501, "Authentication aborted");
    return done();
  }

  const decoded = decodeB64(token);
  const data = decoded.split("\x00");

  if (data.length !== 3) {
    sendCode(ctx, 500, "Error: invalid userdata");
    return done();
  }

  const username = data[1] || data[0] || "";
  const password = data[2] || "";

  ctx.server.onAuth({ method: "PLAIN", username, password }, ctx.session, (err, response) => {
    if (err) {
      sendCode(ctx, err.responseCode ?? 535, err.message);
      return done();
    }
    if (!response?.user) {
      sendCode(ctx, response?.responseCode ?? 535, response?.message ?? "Error: Authentication credentials invalid");
      return done();
    }
    sendAuthSuccess(ctx, response.user);
    done();
  });
}

// ---- LOGIN -----------------------------------------------------------------

export const SASL_LOGIN: AuthHandler = (ctx, args, done) => {
  if (args.length > 1) {
    sendCode(ctx, 501, "Error: syntax: AUTH LOGIN");
    return done();
  }

  if (args.length === 0) {
    ctx.nextHandler = (u, next) => loginUsername(ctx, true, u, next);
    sendCode(ctx, 334, "VXNlcm5hbWU6"); // base64("Username:")
    return done();
  }

  loginUsername(ctx, false, args[0]!, done);
};

function loginUsername(ctx: ConnectionContext, canAbort: boolean, raw: string, done: () => void): void {
  raw = raw.trim();
  if (canAbort && raw === "*") {
    sendCode(ctx, 501, "Authentication aborted");
    return done();
  }

  const username = decodeB64(raw);
  if (!username) {
    sendCode(ctx, 500, "Error: missing username");
    return done();
  }

  ctx.nextHandler = (p, next) => loginPassword(ctx, username, p, next);
  sendCode(ctx, 334, "UGFzc3dvcmQ6"); // base64("Password:")
  done();
}

function loginPassword(ctx: ConnectionContext, username: string, raw: string, done: () => void): void {
  raw = raw.trim();
  if (raw === "*") {
    sendCode(ctx, 501, "Authentication aborted");
    return done();
  }

  const password = decodeB64(raw);

  ctx.server.onAuth({ method: "LOGIN", username, password }, ctx.session, (err, response) => {
    if (err) {
      sendCode(ctx, err.responseCode ?? 535, err.message);
      return done();
    }
    if (!response?.user) {
      sendCode(ctx, response?.responseCode ?? 535, response?.message ?? "Error: Authentication credentials invalid");
      return done();
    }
    sendAuthSuccess(ctx, response.user);
    done();
  });
}

// ---- CRAM-MD5 --------------------------------------------------------------

export const SASL_CRAM_MD5: AuthHandler = (ctx, args, done) => {
  if (args.length > 0) {
    sendCode(ctx, 501, "Error: syntax: AUTH CRAM-MD5");
    return done();
  }

  const rand = String(Math.random()).replace(/^[0.]+/, "").slice(0, 8);
  const ts = Math.floor(Date.now() / 1000);
  const challenge = `<${rand}${ts}@${ctx.name}>`;

  ctx.nextHandler = (token, next) => cramMd5Token(ctx, challenge, true, token, next);
  sendCode(ctx, 334, Buffer.from(challenge).toString("base64"));
  done();
};

function cramMd5Token(
  ctx: ConnectionContext,
  challenge: string,
  canAbort: boolean,
  token: string,
  done: () => void
): void {
  token = token.trim();
  if (canAbort && token === "*") {
    sendCode(ctx, 501, "Authentication aborted");
    return done();
  }

  const decoded = decodeB64(token);
  const spaceIdx = decoded.lastIndexOf(" ");
  const username = decoded.slice(0, spaceIdx);
  const challengeResponse = decoded.slice(spaceIdx + 1).toLowerCase();

  const authObj: AuthObjectCramMd5 = {
    method: "CRAM-MD5",
    username,
    challenge,
    challengeResponse,
    validatePassword(password: string): boolean {
      const hasher = new CryptoHasher("md5", password);
      return hasher.update(challenge).digest("hex").toLowerCase() === challengeResponse;
    }
  };

  ctx.server.onAuth(authObj, ctx.session, (err, response) => {
    if (err) {
      sendCode(ctx, err.responseCode ?? 535, err.message);
      return done();
    }
    if (!response?.user) {
      sendCode(ctx, response?.responseCode ?? 535, response?.message ?? "Error: Authentication credentials invalid");
      return done();
    }
    sendAuthSuccess(ctx, response.user);
    done();
  });
}

// ---- XOAUTH2 ---------------------------------------------------------------

export const SASL_XOAUTH2: AuthHandler = (ctx, args, done) => {
  if (args.length > 1) {
    sendCode(ctx, 501, "Error: syntax: AUTH XOAUTH2 token");
    return done();
  }

  if (args.length === 0) {
    ctx.nextHandler = (t, next) => xoauth2Token(ctx, true, t, next);
    sendRaw(ctx, "334 \r\n");
    return done();
  }

  xoauth2Token(ctx, false, args[0]!, done);
};

function xoauth2Token(ctx: ConnectionContext, canAbort: boolean, token: string, done: () => void): void {
  token = token.trim();
  if (canAbort && token === "*") {
    sendCode(ctx, 501, "Authentication aborted");
    return done();
  }

  let username = "";
  let accessToken = "";

  decodeB64(token)
    .split("\x01")
    .forEach(part => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) return;
      const key = part.slice(0, eqIdx).toLowerCase();
      const value = part.slice(eqIdx + 1).trim();

      if (key === "user") {
        username = value;
      } else if (key === "auth") {
        const spaceIdx = value.indexOf(" ");
        if (spaceIdx !== -1 && value.slice(0, spaceIdx).toLowerCase() === "bearer") {
          accessToken = value.slice(spaceIdx + 1);
        }
      }
    });

  if (!username || !accessToken) {
    sendCode(ctx, 500, "Error: invalid userdata");
    return done();
  }

  ctx.server.onAuth({ method: "XOAUTH2", username, accessToken }, ctx.session, (err, response) => {
    if (err) {
      sendCode(ctx, err.responseCode ?? 535, err.message);
      return done();
    }
    if (!response?.user) {
      // XOAUTH2 challenge: send back challenge data before final error
      ctx.nextHandler = (_, next) => {
        sendCode(ctx, 535, "Error: Username and Password not accepted");
        next();
      };
      const challengeData = Buffer.from(JSON.stringify(response?.data ?? {})).toString("base64");
      sendCode(ctx, response?.responseCode ?? 334, challengeData);
      return done();
    }
    sendAuthSuccess(ctx, response.user);
    done();
  });
}
