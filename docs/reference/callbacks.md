# Callbacks

Lifecycle callbacks hook into each phase of an SMTP session. Set them as constructor options or override them on the server instance after construction.

Call `callback(null)` to accept or `callback(error)` to reject. To send a custom SMTP error code, set `error.responseCode`:

```ts
const err = new Error("Mailbox does not exist");
err.responseCode = 550;
callback(err);
```

---

## onConnect

```ts
onConnect(session: SMTPSession, callback: (err?: Error | null) => void): void
```

Called as soon as a client connects, before any SMTP dialogue. Use this to block connections by IP or apply rate limits.

```ts
const server = new SMTPServer({
  onConnect(session, callback) {
    if (session.remoteAddress === "1.2.3.4") {
      const err = new Error("Blocked");
      err.responseCode = 421;
      return callback(err);
    }
    callback(null);
  },
});
```

---

## onSecure

```ts
onSecure(
  socket: Socket,
  session: SMTPSession,
  callback: (err?: Error | null) => void
): void
```

Called after a successful TLS handshake (both implicit TLS and STARTTLS). Use this to inspect client certificates.

```ts
const server = new SMTPServer({
  requestCert: true,
  onSecure(socket, session, callback) {
    // Inspect TLS details via session.tlsOptions
    console.log(session.tlsOptions); // { name, standardName, version }
    callback(null);
  },
});
```

---

## onAuth

```ts
onAuth(
  auth: AuthObject,
  session: SMTPSession,
  callback: (err: Error | null, response?: AuthResponse) => void
): void
```

Called when a client sends AUTH. The `auth` object varies by method — see [Authentication](/guide/authentication) for details.

```ts
const server = new SMTPServer({
  onAuth(auth, session, callback) {
    if (auth.method === "CRAM-MD5") {
      if (auth.validatePassword("secret")) {
        return callback(null, { user: auth.username });
      }
    } else {
      if (auth.password === "secret") {
        return callback(null, { user: auth.username });
      }
    }
    callback(new Error("Invalid credentials"));
  },
});
```

The `response` object:

| Field | Type | Description |
|-------|------|-------------|
| `user` | `unknown` | Stored on `session.user` for the rest of the connection |
| `message` | `string` | Custom success message |
| `responseCode` | `number` | Custom response code |
| `data` | `Record<string, string>` | XOAUTH2 error challenge data |

---

## onMailFrom

```ts
onMailFrom(
  address: SMTPAddress,
  session: SMTPSession,
  callback: (err?: Error | null) => void
): void
```

Called when the client sends `MAIL FROM`. Use this to validate the sender address or enforce per-user sending policies.

```ts
const server = new SMTPServer({
  onMailFrom(address, session, callback) {
    if (address.address.endsWith("@blocked.example")) {
      return callback(new Error("Sender not allowed"));
    }
    callback(null);
  },
});
```

`address.args` contains ESMTP parameters sent with the command:

```ts
address.args.SIZE     // "1048576"
address.args.BODY     // "8BITMIME"
address.args.SMTPUTF8 // true
```

---

## onRcptTo

```ts
onRcptTo(
  address: SMTPAddress,
  session: SMTPSession,
  callback: (err?: Error | null) => void
): void
```

Called once per `RCPT TO` command. Reject unknown recipients here to avoid accepting mail you cannot deliver.

```ts
const server = new SMTPServer({
  onRcptTo(address, session, callback) {
    const known = ["alice@example.com", "bob@example.com"];
    if (!known.includes(address.address)) {
      const err = new Error("No such user");
      err.responseCode = 550;
      return callback(err);
    }
    callback(null);
  },
});
```

---

## onData

```ts
onData(
  stream: DataStream,
  session: SMTPSession,
  callback: (err: Error | null, message?: string | Array<string | SMTPError>) => void
): void
```

Called when the client begins sending the message body. `stream` is a `ReadableStream<Uint8Array>`. You must consume it completely before calling `callback`.

```ts
const server = new SMTPServer({
  onData(stream, session, callback) {
    async function process() {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString();
      // store or forward the message
      callback(null);
    }
    process().catch(callback);
  },
});
```

### Size limit

When a `size` option is set and the message exceeds it, the stream ends early with `stream.sizeExceeded === true`:

```ts
onData(stream, session, callback) {
  async function process() {
    for await (const chunk of stream) {
      // drain
    }
    if (stream.sizeExceeded) {
      const err = new Error("Message too large");
      err.responseCode = 552;
      return callback(err);
    }
    callback(null);
  }
  process().catch(callback);
}
```

`stream.byteLength` holds the total bytes received after the stream closes.

### LMTP per-recipient responses

In LMTP mode, `callback`'s second argument can be an array with one entry per recipient. Each entry is either a success message string or an `SMTPError`:

```ts
onData(stream, session, callback) {
  async function process() {
    for await (const chunk of stream) {}
    const responses = session.envelope.rcptTo.map((rcpt) => {
      if (rcpt.address === "bad@example.com") {
        const err = new Error("Mailbox full");
        err.responseCode = 452;
        return err;
      }
      return "Message accepted";
    });
    callback(null, responses);
  }
  process().catch(callback);
}
```

---

## onClose

```ts
onClose(session: SMTPSession): void
```

Called when a connection closes, regardless of reason. No callback — return value is ignored. Use this for cleanup or logging.

```ts
const server = new SMTPServer({
  onClose(session) {
    console.log(`Connection ${session.id} closed after ${session.transaction} transactions`);
  },
});
```
