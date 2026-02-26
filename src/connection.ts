/**
 * Per-connection SMTP state machine.
 *
 * All mutable state lives in ConnectionContext (stored in socket.data).
 * Processing is serialized via an async drain loop to preserve command order
 * even though Bun's socket.data() hook is synchronous.
 */

import type { Socket } from "bun";
import { parseAddressCommand } from "./address-parser.ts";
import {
	computeTransmissionType,
	SASL_CRAM_MD5,
	SASL_LOGIN,
	SASL_PLAIN,
	SASL_XOAUTH2,
} from "./auth.ts";
import { SMTPParser } from "./smtp-parser.ts";
import type {
	ConnectionContext,
	DataStream,
	ServerInstance,
	SMTPAddress,
	SMTPError,
	SMTPSession,
} from "./types.ts";

const SOCKET_TIMEOUT = 60_000;

// Enhanced status codes (RFC 3463)
const ENHANCED_STATUS_CODES: Record<number, string> = {
	200: "2.0.0",
	211: "2.0.0",
	214: "2.0.0",
	220: "2.0.0",
	221: "2.0.0",
	235: "2.7.0",
	250: "2.0.0",
	251: "2.1.5",
	252: "2.1.5",
	334: "3.7.0",
	354: "2.0.0",
	420: "4.4.2",
	421: "4.4.2",
	450: "4.2.1",
	451: "4.3.0",
	452: "4.2.2",
	454: "4.7.0",
	500: "5.5.2",
	501: "5.5.4",
	502: "5.5.1",
	503: "5.5.1",
	504: "5.5.4",
	521: "5.3.2",
	523: "5.3.4",
	530: "5.7.0",
	535: "5.7.8",
	538: "5.7.0",
	550: "5.1.1",
	551: "5.1.6",
	552: "5.2.2",
	553: "5.1.3",
	554: "5.6.0",
	555: "5.5.4",
	556: "5.1.10",
	557: "5.7.1",
	558: "5.2.3",
};

const CONTEXTUAL_STATUS_CODES: Record<string, string> = {
	MAIL_FROM_OK: "2.1.0",
	RCPT_TO_OK: "2.1.5",
	DATA_OK: "2.6.0",
	AUTH_SUCCESS: "2.7.0",
	AUTH_REQUIRED: "5.7.0",
	AUTH_INVALID: "5.7.8",
	POLICY_VIOLATION: "5.7.1",
	SPAM_REJECTED: "5.7.1",
	MAILBOX_FULL: "4.2.2",
	MAILBOX_NOT_FOUND: "5.1.1",
	MAILBOX_SYNTAX_ERROR: "5.1.3",
	SYSTEM_ERROR: "4.3.0",
	SYSTEM_FULL: "4.3.1",
	NETWORK_ERROR: "4.4.0",
	CONNECTION_TIMEOUT: "4.4.2",
};

const SKIPPED_ENHANCED_COMMANDS = new Set(["HELO", "EHLO", "LHLO"]);
const COMMANDS_REQUIRING_HELO = new Set(["MAIL", "RCPT", "DATA", "AUTH"]);
const COMMANDS_REQUIRING_AUTH = new Set(["MAIL", "RCPT", "DATA"]);

// Pre-built strings for the most frequent SMTP replies.
// ENH variants: hideENHANCEDSTATUSCODES=false. PLAIN variants: default (=true).
const R_MAIL_OK = "250 2.1.0 Accepted\r\n";
const R_MAIL_OK_PLAIN = "250 Accepted\r\n";
const R_RCPT_OK = "250 2.1.5 Accepted\r\n";
const R_RCPT_OK_PLAIN = "250 Accepted\r\n";
const R_DATA_354 = "354 End data with <CR><LF>.<CR><LF>\r\n";
const R_DATA_OK = "250 2.6.0 OK: message queued\r\n";
const R_DATA_OK_PLAIN = "250 OK: message queued\r\n";
const R_RSET_OK = "250 2.0.0 Flushed\r\n";
const R_RSET_OK_PLAIN = "250 Flushed\r\n";
const R_NOOP_OK = "250 OK\r\n";
const R_NOOP_OK_ENH = "250 2.0.0 OK\r\n";
const R_QUIT = "221 Bye\r\n";
const R_QUIT_ENH = "221 2.0.0 Bye\r\n";

// ---- Factory ---------------------------------------------------------------

export function createContext(
	server: ServerInstance,
	socket: Socket<ConnectionContext>,
): ConnectionContext {
	const id = BigInt(
		"0x" +
			Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString("hex"),
	)
		.toString(32)
		.padStart(16, "0");

	const localAddress = (socket.localAddress ?? "").replace(/^::ffff:/, "");
	const localPort = socket.localPort ?? 0;
	const remoteAddress = (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
	const remotePort = socket.remotePort ?? 0;

	const session: SMTPSession = {
		id,
		secure: !!server.options.secure,
		servername: undefined,
		localAddress,
		localPort,
		remoteAddress,
		remotePort,
		clientHostname: "",
		openingCommand: "",
		hostNameAppearsAs: "",
		xClient: new Map(),
		xForward: new Map(),
		transmissionType: server.options.lmtp ? "LMTP" : "SMTP",
		tlsOptions: false,
		user: undefined,
		transaction: 1,
		envelope: {
			mailFrom: false,
			rcptTo: [],
			bodyType: "7bit",
			smtpUtf8: false,
			requireTLS: false,
		},
	};

	const ctx: ConnectionContext = {
		id,
		session,
		server,
		socket,
		processing: false,
		pendingChunks: [],
		parser: new SMTPParser(),
		ready: false,
		secure: !!server.options.secure,
		upgrading: false,
		closing: false,
		closed: false,
		canEmitConnection: true,
		nextHandler: null,
		unauthCmds: 0,
		unknownCmds: 0,
		transactionCounter: 0,
		maxAllowedUnauthCmds:
			server.options.maxAllowedUnauthenticatedCommands === false
				? Infinity
				: (server.options.maxAllowedUnauthenticatedCommands ?? 10),
		name: server.options.name ?? "localhost",
		localAddress,
		localPort,
		remoteAddress,
		remotePort,
		clientHostname: "",
		openingCommand: "",
		hostNameAppearsAs: "",
		xClient: session.xClient,
		xForward: session.xForward,
		tlsOptions: false,
		timeoutHandle: null,
		lastActivity: 0,
		dataController: null,
		dataStream: null,
		dataBytes: 0,
		dataMaxBytes: server.options.size ?? Infinity,
	};

	return ctx;
}

// ---- Init (called from socket.open) ----------------------------------------

export function initConnection(ctx: ConnectionContext): void {
	resetTimeout(ctx);

	// 100ms early-talker delay
	const t = setTimeout(() => connectionReady(ctx), 100);
	if (typeof t.unref === "function") t.unref();
}

async function connectionReady(ctx: ConnectionContext): Promise<void> {
	if (ctx.closing || ctx.closed) return;

	ctx.clientHostname = await reverseResolve(ctx);
	ctx.session.clientHostname = ctx.clientHostname;

	resetSession(ctx);

	// onConnect hook
	await new Promise<void>((resolve, reject) => {
		ctx.server.onConnect(ctx.session, (err) => {
			if (err) reject(err);
			else resolve();
		});
	}).catch((err: SMTPError) => {
		sendRaw(
			ctx,
			buildResponse(ctx, err.responseCode ?? 554, err.message, false),
		);
		closeSocket(ctx);
		return;
	});

	if (ctx.closing || ctx.closed) return;

	// onSecure hook for initial TLS connections
	if (ctx.secure) {
		await new Promise<void>((resolve, reject) => {
			ctx.server.onSecure(ctx.socket, ctx.session, (err) => {
				if (err) reject(err);
				else resolve();
			});
		}).catch((err: SMTPError) => {
			handleError(ctx, err);
			return;
		});
	}

	if (ctx.closing || ctx.closed) return;

	if (!ctx.server.options.useXClient && !ctx.server.options.useXForward) {
		emitConnection(ctx);
	}

	ctx.ready = true;
	const greeting = `${ctx.name} ${ctx.server.options.lmtp ? "LMTP" : "ESMTP"}${ctx.server.options.banner ? ` ${ctx.server.options.banner}` : ""}`;
	sendRaw(ctx, buildResponse(ctx, 220, greeting, false));
}

// ---- Chunk processing queue -------------------------------------------------

export function enqueueChunk(ctx: ConnectionContext, raw: Buffer): void {
	ctx.pendingChunks.push(raw); // caller already owns this buffer (copied at socket.data)
	if (!ctx.processing) {
		ctx.processing = true;
		void drainChunks(ctx);
	}
}

async function drainChunks(ctx: ConnectionContext): Promise<void> {
	let i = 0;
	while (i < ctx.pendingChunks.length) {
		await processChunk(ctx, ctx.pendingChunks[i] as Buffer);
		i++;
	}
	ctx.pendingChunks.length = 0;
	ctx.processing = false;
}

async function processChunk(
	ctx: ConnectionContext,
	chunk: Buffer,
): Promise<void> {
	if (ctx.closed || ctx.parser.isClosed) return;

	// Refresh inactivity timeout
	resetTimeout(ctx);

	if (ctx.parser.dataMode) {
		ctx.parser.feedDataMode(chunk);
		return;
	}

	const lines = ctx.parser.feedCommandMode(chunk);
	for (const line of lines) {
		if (ctx.closed) break;
		await processLine(ctx, line);
	}
}

// ---- Line dispatch ---------------------------------------------------------

async function processLine(
	ctx: ConnectionContext,
	line: string,
): Promise<void> {
	if (!ctx.ready) {
		sendRaw(ctx, buildResponse(ctx, 421, `${ctx.name} You talk too soon`));
		return;
	}

	// Block HTTP requests (web page AJAX attacks)
	if (
		line.includes(" /") &&
		/^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i.test(
			line,
		)
	) {
		sendRaw(ctx, buildResponse(ctx, 421, "HTTP requests not allowed"));
		return;
	}

	if (ctx.upgrading) return; // ignore commands during TLS upgrade

	// Multi-step auth or other stateful handlers
	if (ctx.nextHandler) {
		const handler = ctx.nextHandler;
		ctx.nextHandler = null;
		await new Promise<void>((resolve) => handler(line, resolve));
		return;
	}

	const firstCode = line.charCodeAt(0);
	const lastCode = line.charCodeAt(line.length - 1);
	const trimmed = firstCode <= 0x20 || lastCode <= 0x20 ? line.trim() : line;
	const sp = trimmed.indexOf(" ");
	const commandName = (
		sp === -1 ? trimmed : trimmed.slice(0, sp)
	).toUpperCase();

	// Server shutting down
	if (ctx.server.closing) {
		sendRaw(ctx, buildResponse(ctx, 421, "Server shutting down", commandName));
		return;
	}

	// LMTP: HELO and EHLO not allowed; LHLO is required
	if (ctx.server.options.lmtp) {
		if (commandName === "HELO" || commandName === "EHLO") {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					500,
					`Error: ${commandName} not allowed in LMTP server`,
				),
			);
			return;
		}
	}

	// Track opening command
	if (
		commandName === "HELO" ||
		commandName === "EHLO" ||
		commandName === "LHLO"
	) {
		ctx.openingCommand = commandName;
		ctx.session.openingCommand = commandName;
	}

	// Map LHLO -> EHLO handler
	const effectiveCommand =
		ctx.server.options.lmtp && commandName === "LHLO" ? "EHLO" : commandName;

	const handler = getHandler(ctx, effectiveCommand);

	if (!handler) {
		ctx.unknownCmds++;
		if (ctx.unknownCmds >= 10) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					421,
					"Error: too many unrecognized commands",
					commandName,
				),
			);
			return;
		}
		sendRaw(
			ctx,
			buildResponse(ctx, 500, "Error: command not recognized", commandName),
		);
		return;
	}

	// Unauthenticated command limit
	if (
		!ctx.session.user &&
		isSupported(ctx, "AUTH") &&
		!ctx.server.options.authOptional &&
		effectiveCommand !== "AUTH" &&
		ctx.maxAllowedUnauthCmds !== Infinity
	) {
		ctx.unauthCmds++;
		if (ctx.unauthCmds >= ctx.maxAllowedUnauthCmds) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					421,
					"Error: too many unauthenticated commands",
					commandName,
				),
			);
			return;
		}
	}

	// Require HELO/EHLO before MAIL/RCPT/DATA/AUTH
	if (!ctx.hostNameAppearsAs && COMMANDS_REQUIRING_HELO.has(effectiveCommand)) {
		sendRaw(
			ctx,
			buildResponse(
				ctx,
				503,
				`Error: send ${ctx.server.options.lmtp ? "LHLO" : "HELO/EHLO"} first`,
			),
		);
		return;
	}

	// Require authentication for MAIL/RCPT/DATA
	if (
		!ctx.session.user &&
		isSupported(ctx, "AUTH") &&
		COMMANDS_REQUIRING_AUTH.has(effectiveCommand) &&
		!ctx.server.options.authOptional
	) {
		const msg =
			typeof ctx.server.options.authRequiredMessage === "string"
				? ctx.server.options.authRequiredMessage
				: "Error: authentication Required";
		sendRaw(ctx, buildResponse(ctx, 530, msg));
		return;
	}

	await handler(ctx, line);
}

// ---- Command handlers -------------------------------------------------------

type Handler = (ctx: ConnectionContext, line: string) => void | Promise<void>;

function getHandler(ctx: ConnectionContext, command: string): Handler | null {
	if (!isSupported(ctx, command)) return null;
	return HANDLERS[command] ?? null;
}

function isSupported(ctx: ConnectionContext, command: string): boolean {
	if (ctx.server.disabledCommandsSet.has(command)) return false;
	return command in HANDLERS;
}

const HANDLERS: Record<string, Handler> = {
	EHLO(ctx, line) {
		const t = line.trim();
		const sp = t.indexOf(" ");
		if (sp === -1) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					501,
					`Error: syntax: ${ctx.server.options.lmtp ? "LHLO" : "EHLO"} hostname`,
				),
			);
			return;
		}

		ctx.hostNameAppearsAs = t
			.slice(sp + 1)
			.trim()
			.toLowerCase();
		ctx.session.hostNameAppearsAs = ctx.hostNameAppearsAs;

		const features: string[] = [];

		if (!ctx.server.options.hidePIPELINING) features.push("PIPELINING");
		if (!ctx.server.options.hide8BITMIME) features.push("8BITMIME");
		if (!ctx.server.options.hideSMTPUTF8) features.push("SMTPUTF8");
		if (!ctx.server.options.hideENHANCEDSTATUSCODES)
			features.push("ENHANCEDSTATUSCODES");
		if (!ctx.server.options.hideDSN) features.push("DSN");

		if (
			ctx.server.options.authMethods.length > 0 &&
			isSupported(ctx, "AUTH") &&
			!ctx.session.user
		) {
			features.push(`AUTH ${ctx.server.options.authMethods.join(" ")}`);
		}

		if (
			!ctx.secure &&
			isSupported(ctx, "STARTTLS") &&
			!ctx.server.options.hideSTARTTLS
		) {
			features.push("STARTTLS");
		}

		if (ctx.secure && !ctx.server.options.hideREQUIRETLS) {
			features.push("REQUIRETLS");
		}

		if (ctx.server.options.size) {
			features.push(
				"SIZE" +
					(ctx.server.options.hideSize ? "" : ` ${ctx.server.options.size}`),
			);
		}

		if (
			!ctx.xClient.has("ADDR") &&
			ctx.server.options.useXClient &&
			isSupported(ctx, "XCLIENT")
		) {
			features.push("XCLIENT NAME ADDR PORT PROTO HELO LOGIN");
		}

		if (
			!ctx.xClient.has("ADDR") &&
			ctx.server.options.useXForward &&
			isSupported(ctx, "XFORWARD")
		) {
			features.push("XFORWARD NAME ADDR PORT PROTO HELO IDENT SOURCE");
		}

		resetSession(ctx);

		const heloFmt =
			ctx.server.options.heloResponse || "%s Nice to meet you, %s";
		let heloMsg = heloFmt;
		const p1 = heloFmt.indexOf("%s");
		if (p1 !== -1) {
			heloMsg = heloFmt.slice(0, p1) + ctx.name + heloFmt.slice(p1 + 2);
			const p2 = heloMsg.indexOf("%s");
			if (p2 !== -1) {
				heloMsg =
					heloMsg.slice(0, p2) + ctx.clientHostname + heloMsg.slice(p2 + 2);
			}
		}

		sendRaw(ctx, buildMultiResponse(ctx, 250, [heloMsg, ...features], false));
	},

	HELO(ctx, line) {
		const t = line.trim();
		const sp = t.indexOf(" ");
		if (sp === -1) {
			sendRaw(ctx, buildResponse(ctx, 501, "Error: Syntax: HELO hostname"));
			return;
		}

		ctx.hostNameAppearsAs = t
			.slice(sp + 1)
			.trim()
			.toLowerCase();
		ctx.session.hostNameAppearsAs = ctx.hostNameAppearsAs;

		resetSession(ctx);

		const heloFmt =
			ctx.server.options.heloResponse || "%s Nice to meet you, %s";
		let heloMsg = heloFmt;
		const p1 = heloFmt.indexOf("%s");
		if (p1 !== -1) {
			heloMsg = heloFmt.slice(0, p1) + ctx.name + heloFmt.slice(p1 + 2);
			const p2 = heloMsg.indexOf("%s");
			if (p2 !== -1) {
				heloMsg =
					heloMsg.slice(0, p2) + ctx.clientHostname + heloMsg.slice(p2 + 2);
			}
		}

		sendRaw(ctx, buildResponse(ctx, 250, heloMsg, false));
	},

	STARTTLS(ctx) {
		if (ctx.secure) {
			sendRaw(ctx, buildResponse(ctx, 503, "Error: TLS already active"));
			return;
		}

		sendRaw(ctx, buildResponse(ctx, 220, "Ready to start TLS"));
		ctx.upgrading = true;

		// upgradeTLS returns [raw, tls] and requires socket handlers for the new TLS socket.
		// The open() callback fires when the TLS handshake completes.
		ctx.socket.upgradeTLS<ConnectionContext>({
			data: ctx,
			tls: {
				key: ctx.server.tlsKey,
				cert: ctx.server.tlsCert,
			},
			socket: {
				open(tlsSocket) {
					ctx.socket = tlsSocket;
					ctx.secure = true;
					ctx.session.secure = true;
					ctx.upgrading = false;

					ctx.server.onSecure(tlsSocket, ctx.session, (err) => {
						if (err) {
							handleError(ctx, err as SMTPError);
							return;
						}
						// RFC: server MUST reset all state after STARTTLS
						ctx.hostNameAppearsAs = "";
						ctx.session.hostNameAppearsAs = "";
						ctx.openingCommand = "";
						ctx.session.openingCommand = "";
						resetSession(ctx);
					});
				},
				data(tlsSocket, chunk) {
					const ctx = tlsSocket.data;
					const buf = Buffer.from(chunk);
					if (ctx.parser.dataMode) {
						ctx.parser.feedDataMode(buf);
					} else {
						enqueueChunk(ctx, buf);
					}
				},
				close(tlsSocket) {
					handleClose(tlsSocket.data);
				},
				error(tlsSocket, err) {
					handleError(tlsSocket.data, err as SMTPError);
				},
			},
		});
	},

	async AUTH(ctx, line) {
		const parts = line.trim().split(" ");
		parts.shift(); // remove "AUTH"
		const method = (parts.shift() ?? "").toUpperCase();
		const args = parts;

		if (!ctx.server.options.authMethods.includes(method)) {
			sendRaw(
				ctx,
				buildResponse(ctx, 504, `Unrecognized authentication type. ${method}`),
			);
			return;
		}

		if (!ctx.server.options.allowInsecureAuth && !ctx.secure) {
			sendRaw(
				ctx,
				buildResponse(ctx, 538, "Error: Must issue a STARTTLS command first"),
			);
			return;
		}

		if (ctx.session.user) {
			sendRaw(
				ctx,
				buildResponse(ctx, 503, "Error: No identity changes permitted"),
			);
			return;
		}

		const saslFn = {
			PLAIN: SASL_PLAIN,
			LOGIN: SASL_LOGIN,
			"CRAM-MD5": SASL_CRAM_MD5,
			XOAUTH2: SASL_XOAUTH2,
		}[method];

		if (!saslFn) {
			sendRaw(
				ctx,
				buildResponse(ctx, 504, `Unrecognized authentication type. ${method}`),
			);
			return;
		}

		await new Promise<void>((resolve) => saslFn(ctx, args, resolve));
	},

	async MAIL(ctx, line) {
		emitConnection(ctx);

		const parsed = parseAddressCommand("MAIL FROM", line);
		if (!parsed) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					501,
					"Error: Bad sender address syntax",
					"MAILBOX_SYNTAX_ERROR",
				),
			);
			return;
		}

		if (ctx.session.envelope.mailFrom) {
			sendRaw(ctx, buildResponse(ctx, 503, "Error: nested MAIL command"));
			return;
		}

		if (
			!ctx.server.options.hideSize &&
			ctx.server.options.size &&
			parsed.args &&
			parsed.args.SIZE &&
			Number(parsed.args.SIZE) > ctx.server.options.size
		) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					552,
					`Error: message exceeds fixed maximum message size ${ctx.server.options.size}`,
					"SYSTEM_FULL",
				),
			);
			return;
		}

		// Validate BODY param
		const validationErr = validateMailParams(ctx, parsed);
		if (validationErr) {
			sendRaw(
				ctx,
				buildResponse(ctx, validationErr.code, validationErr.message),
			);
			return;
		}

		applyMailParams(ctx, parsed);

		await new Promise<void>((resolve) => {
			ctx.server.onMailFrom(parsed, ctx.session, (err) => {
				if (err) {
					sendRaw(
						ctx,
						buildResponse(
							ctx,
							(err as SMTPError).responseCode ?? 550,
							err.message,
						),
					);
					resolve();
					return;
				}
				ctx.session.envelope.mailFrom = parsed;
				sendRaw(
					ctx,
					ctx.server.options.hideENHANCEDSTATUSCODES
						? R_MAIL_OK_PLAIN
						: R_MAIL_OK,
				);
				resolve();
			});
		});
	},

	async RCPT(ctx, line) {
		const parsed = parseAddressCommand("RCPT TO", line);

		if (!parsed || !parsed.address) {
			sendRaw(
				ctx,
				buildResponse(
					ctx,
					501,
					"Error: Bad recipient address syntax",
					"MAILBOX_SYNTAX_ERROR",
				),
			);
			return;
		}

		if (!ctx.session.envelope.mailFrom) {
			sendRaw(ctx, buildResponse(ctx, 503, "Error: need MAIL command"));
			return;
		}

		// DSN params
		if (!ctx.server.options.hideDSN && parsed.args) {
			if (parsed.args.NOTIFY) {
				const notifyStr = parsed.args.NOTIFY;
				if (typeof notifyStr === "string") {
					const validValues = ["NEVER", "SUCCESS", "FAILURE", "DELAY"];
					const values = notifyStr.toUpperCase().split(",");
					for (const v of values) {
						if (!validValues.includes(v)) {
							sendRaw(
								ctx,
								buildResponse(
									ctx,
									501,
									"Error: NOTIFY parameter must be NEVER, SUCCESS, FAILURE, or DELAY",
								),
							);
							return;
						}
					}
					if (values.includes("NEVER") && values.length > 1) {
						sendRaw(
							ctx,
							buildResponse(
								ctx,
								501,
								"Error: NOTIFY=NEVER cannot be combined with other values",
							),
						);
						return;
					}
					parsed.dsn = parsed.dsn ?? {};
					parsed.dsn.notify = values;
				}
			}
			if (parsed.args.ORCPT && typeof parsed.args.ORCPT === "string") {
				parsed.dsn = parsed.dsn ?? {};
				parsed.dsn.orcpt = parsed.args.ORCPT;
			}
		}

		await new Promise<void>((resolve) => {
			ctx.server.onRcptTo(parsed, ctx.session, (err) => {
				if (err) {
					sendRaw(
						ctx,
						buildResponse(
							ctx,
							(err as SMTPError).responseCode ?? 550,
							err.message,
						),
					);
					resolve();
					return;
				}

				// Overwrite duplicate recipients
				const existing = ctx.session.envelope.rcptTo.findIndex(
					(r) => r.address.toLowerCase() === parsed.address.toLowerCase(),
				);
				if (existing >= 0) {
					ctx.session.envelope.rcptTo[existing] = parsed;
				} else {
					ctx.session.envelope.rcptTo.push(parsed);
				}

				sendRaw(
					ctx,
					ctx.server.options.hideENHANCEDSTATUSCODES
						? R_RCPT_OK_PLAIN
						: R_RCPT_OK,
				);
				resolve();
			});
		});
	},

	async DATA(ctx) {
		if (ctx.session.envelope.rcptTo.length === 0) {
			sendRaw(ctx, buildResponse(ctx, 503, "Error: need RCPT command"));
			return;
		}

		sendRaw(ctx, R_DATA_354);

		// Create a ReadableStream backed by the dot-unstuffer
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		}) as DataStream;

		ctx.dataController = controller;
		ctx.dataStream = stream;
		ctx.dataBytes = 0;

		// Switch parser to data mode
		ctx.parser.startDataMode(ctx.server.options.size ?? 0, {
			onData(chunk) {
				controller.enqueue(new Uint8Array(chunk));
				ctx.dataBytes += chunk.length;
			},
			onDataEnd(byteLength, sizeExceeded) {
				stream.byteLength = byteLength;
				stream.sizeExceeded = sizeExceeded;
				controller.close();
				ctx.dataController = null;
				ctx.dataStream = null;
			},
			onDataRemainder(remainder) {
				// Re-inject pipelined commands that arrived after the terminator
				enqueueChunk(ctx, remainder);
			},
		});

		// Call user's onData handler. It must consume the stream.
		await new Promise<void>((resolve) => {
			ctx.server.onData(stream, ctx.session, (err, message) => {
				const rcptCount = ctx.session.envelope.rcptTo.length;

				if (err) {
					if (ctx.server.options.lmtp) {
						for (let i = 0; i < rcptCount; i++) {
							sendRaw(
								ctx,
								buildResponse(
									ctx,
									(err as SMTPError).responseCode ?? 450,
									err.message,
								),
							);
						}
					} else {
						sendRaw(
							ctx,
							buildResponse(
								ctx,
								(err as SMTPError).responseCode ?? 450,
								err.message,
							),
						);
					}
				} else if (Array.isArray(message)) {
					for (const resp of message) {
						if (
							resp instanceof Error ||
							(resp as unknown as SMTPError).responseCode
						) {
							const e = resp as unknown as SMTPError;
							sendRaw(
								ctx,
								buildResponse(ctx, e.responseCode ?? 450, e.message),
							);
						} else {
							sendRaw(
								ctx,
								buildResponse(
									ctx,
									250,
									typeof resp === "string" ? resp : "OK: message accepted",
									"DATA_OK",
								),
							);
						}
					}
				} else if (ctx.server.options.lmtp) {
					for (let i = 0; i < rcptCount; i++) {
						sendRaw(
							ctx,
							buildResponse(
								ctx,
								250,
								typeof message === "string" ? message : "OK: message accepted",
								"DATA_OK",
							),
						);
					}
				} else {
					sendRaw(
						ctx,
						typeof message === "string"
							? buildResponse(ctx, 250, message, "DATA_OK")
							: ctx.server.options.hideENHANCEDSTATUSCODES
								? R_DATA_OK_PLAIN
								: R_DATA_OK,
					);
				}

				ctx.transactionCounter++;
				ctx.unknownCmds = 0;
				resetSession(ctx);
				resolve();
			});
		});
	},

	RSET(ctx) {
		resetSession(ctx);
		sendRaw(
			ctx,
			ctx.server.options.hideENHANCEDSTATUSCODES ? R_RSET_OK_PLAIN : R_RSET_OK,
		);
	},

	NOOP(ctx) {
		sendRaw(
			ctx,
			ctx.server.options.hideENHANCEDSTATUSCODES ? R_NOOP_OK : R_NOOP_OK_ENH,
		);
	},

	QUIT(ctx) {
		sendRaw(
			ctx,
			ctx.server.options.hideENHANCEDSTATUSCODES ? R_QUIT : R_QUIT_ENH,
		);
		closeSocket(ctx);
	},

	VRFY(ctx) {
		sendRaw(
			ctx,
			buildResponse(ctx, 252, "Try to send something. No promises though"),
		);
	},

	HELP(ctx) {
		sendRaw(
			ctx,
			buildResponse(
				ctx,
				214,
				"See https://tools.ietf.org/html/rfc5321 for details",
			),
		);
	},

	XCLIENT(ctx, line) {
		if (ctx.xClient.has("ADDR") || !ctx.server.options.useXClient) {
			sendRaw(ctx, buildResponse(ctx, 550, "Error: Not allowed"));
			return;
		}

		if (ctx.session.envelope.mailFrom) {
			sendRaw(
				ctx,
				buildResponse(ctx, 503, "Error: Mail transaction in progress"),
			);
			return;
		}

		const allowedKeys = ["NAME", "ADDR", "PORT", "PROTO", "HELO", "LOGIN"];
		const parts = line.trim().split(/\s+/);
		parts.shift(); // remove XCLIENT

		if (parts.length === 0) {
			sendRaw(
				ctx,
				buildResponse(ctx, 501, "Error: Bad command parameter syntax"),
			);
			return;
		}

		const data = new Map<string, string | false>();
		let loginValue: string | false = false;

		for (const part of parts) {
			const eqIdx = part.indexOf("=");
			if (eqIdx === -1 || eqIdx === part.length - 1) {
				sendRaw(
					ctx,
					buildResponse(ctx, 501, "Error: Bad command parameter syntax"),
				);
				return;
			}
			const key = part.slice(0, eqIdx).toUpperCase();
			if (!allowedKeys.includes(key)) {
				sendRaw(
					ctx,
					buildResponse(ctx, 501, "Error: Bad command parameter syntax"),
				);
				return;
			}
			const rawVal = part
				.slice(eqIdx + 1)
				.replace(/\+([0-9A-F]{2})/gi, (_, h: string) =>
					String.fromCharCode(parseInt(h, 16)),
				);
			const value: string | false = ["[UNAVAILABLE]", "[TEMPUNAVAIL]"].includes(
				rawVal.toUpperCase(),
			)
				? false
				: rawVal;

			if (data.has(key)) continue;
			data.set(key, value);

			if (key === "LOGIN") {
				loginValue = value;
			} else if (key === "ADDR" && value) {
				if (!ctx.xClient.has("ADDR:DEFAULT")) {
					ctx.xClient.set("ADDR:DEFAULT", ctx.remoteAddress);
				}
				ctx.remoteAddress = value.replace(/^IPV6:/i, "");
				ctx.session.remoteAddress = ctx.remoteAddress;
				ctx.hostNameAppearsAs = "";
				ctx.session.hostNameAppearsAs = "";
			} else if (key === "NAME") {
				if (!ctx.xClient.has("NAME:DEFAULT")) {
					ctx.xClient.set("NAME:DEFAULT", ctx.clientHostname);
				}
				ctx.clientHostname =
					typeof value === "string" ? value.toLowerCase() : "";
				ctx.session.clientHostname = ctx.clientHostname;
			} else if (key === "PORT" && value) {
				ctx.remotePort = Number(value) || ctx.remotePort;
				ctx.session.remotePort = ctx.remotePort;
			}
		}

		for (const [k, v] of data) {
			ctx.xClient.set(k, v);
		}

		if (loginValue !== false) {
			// Authenticate the proxied user via XCLIENT
			ctx.server.onAuth(
				{ method: "XCLIENT", username: loginValue, password: null },
				ctx.session,
				(err, response) => {
					if (err || !response?.user) {
						// proceed without auth
					} else {
						ctx.session.user = response.user;
						ctx.session.transmissionType = computeTransmissionType(ctx);
					}
				},
			);
		}

		if (!ctx.server.options.useXForward && !ctx.server.options.useXClient) {
			emitConnection(ctx);
		}

		sendRaw(
			ctx,
			buildResponse(
				ctx,
				220,
				`${ctx.name} ${ctx.server.options.lmtp ? "LMTP" : "ESMTP"}${ctx.server.options.banner ? ` ${ctx.server.options.banner}` : ""}`,
			),
		);
	},

	XFORWARD(ctx, line) {
		if (ctx.xClient.has("ADDR") || !ctx.server.options.useXForward) {
			sendRaw(ctx, buildResponse(ctx, 550, "Error: Not allowed"));
			return;
		}

		const allowedKeys = [
			"NAME",
			"ADDR",
			"PORT",
			"PROTO",
			"HELO",
			"IDENT",
			"SOURCE",
		];
		const parts = line.trim().split(/\s+/);
		parts.shift();

		if (parts.length === 0) {
			sendRaw(
				ctx,
				buildResponse(ctx, 501, "Error: Bad command parameter syntax"),
			);
			return;
		}

		for (const part of parts) {
			const eqIdx = part.indexOf("=");
			if (eqIdx === -1) continue;
			const key = part.slice(0, eqIdx).toUpperCase();
			if (!allowedKeys.includes(key)) continue;
			const rawVal = part
				.slice(eqIdx + 1)
				.replace(/\+([0-9A-F]{2})/gi, (_, h: string) =>
					String.fromCharCode(parseInt(h, 16)),
				);
			const value: string | false = ["[UNAVAILABLE]", "[TEMPUNAVAIL]"].includes(
				rawVal.toUpperCase(),
			)
				? false
				: rawVal;
			ctx.xForward.set(key, value);
		}

		emitConnection(ctx);
		sendRaw(ctx, buildResponse(ctx, 250, "Ok"));
	},

	// Sendmail compatibility stubs
	WIZ(ctx, line) {
		const parts = line.trim().split(/\s+/);
		parts.shift();
		const password = parts.shift() ?? "";
		if (!password) {
			sendRaw(ctx, buildResponse(ctx, 500, "You are no wizard!"));
			return;
		}
		ctx.session.isWizard = true;
		sendRaw(ctx, buildResponse(ctx, 200, "Please pass, oh mighty wizard"));
	},

	SHELL(ctx) {
		if (!ctx.session.isWizard) {
			sendRaw(
				ctx,
				buildResponse(ctx, 500, "Mere mortals must not mutter that mantra"),
			);
			return;
		}
		sendRaw(
			ctx,
			buildResponse(
				ctx,
				500,
				"Error: Invoking shell is not allowed. This incident will be reported.",
			),
		);
	},

	KILL(ctx) {
		sendRaw(ctx, buildResponse(ctx, 500, "Can not kill Mom"));
	},
};

// ---- Response builders -----------------------------------------------------

function getEnhancedCode(
	ctx: ConnectionContext,
	code: number,
	context?: string | false,
): string {
	if (context === false || ctx.server.options.hideENHANCEDSTATUSCODES)
		return "";
	if (code >= 300 && code < 400) return ""; // RFC 2034: skip 3xx
	if (context && SKIPPED_ENHANCED_COMMANDS.has(context)) return "";
	const contextCode = context && CONTEXTUAL_STATUS_CODES[context];
	if (contextCode) return contextCode;
	const enhancedCode = ENHANCED_STATUS_CODES[code];
	if (enhancedCode) return enhancedCode;
	if (code >= 200 && code < 300) return "2.0.0";
	if (code >= 400 && code < 500) return "4.0.0";
	if (code >= 500) return "5.0.0";
	return "";
}

function buildResponse(
	ctx: ConnectionContext,
	code: number,
	message = "",
	context?: string | false,
): string {
	const enh = getEnhancedCode(ctx, code, context);
	const codeStr = String(code);
	let payload: string;
	if (enh && message) {
		payload = `${codeStr} ${enh} ${message}`;
	} else if (enh) {
		payload = `${codeStr} ${enh}`;
	} else if (message) {
		payload = `${codeStr} ${message}`;
	} else {
		payload = codeStr;
	}

	if (code >= 400) ctx.session.error = payload;
	if (code === 334 && payload === "334") return "334 \r\n";

	const response = `${payload}\r\n`;
	if (code === 421) {
		// 421 closes the connection
		setImmediate(() => closeSocket(ctx));
	}
	return response;
}

function buildMultiResponse(
	ctx: ConnectionContext,
	code: number,
	lines: string[],
	context?: string | false,
): string {
	const enh = getEnhancedCode(ctx, code, context);
	const result = lines
		.map((line, i) => {
			const sep = i < lines.length - 1 ? "-" : " ";
			const prefix = enh ? `${code}${sep}${enh} ` : `${code}${sep}`;
			return prefix + line;
		})
		.join("\r\n");
	return `${result}\r\n`;
}

function sendRaw(ctx: ConnectionContext, data: string): void {
	if (!ctx.closed && !ctx.closing) {
		ctx.socket.write(data);
	}
}

// ---- Session management ----------------------------------------------------

export function resetSession(ctx: ConnectionContext): void {
	const s = ctx.session;
	s.localAddress = ctx.localAddress;
	s.localPort = ctx.localPort;
	s.remoteAddress = ctx.remoteAddress;
	s.remotePort = ctx.remotePort;
	s.clientHostname = ctx.clientHostname;
	s.openingCommand = ctx.openingCommand;
	s.hostNameAppearsAs = ctx.hostNameAppearsAs;
	s.xClient = ctx.xClient;
	s.xForward = ctx.xForward;
	s.transmissionType = computeTransmissionType(ctx);
	s.tlsOptions = ctx.tlsOptions;
	s.envelope = {
		mailFrom: false,
		rcptTo: [],
		bodyType: "7bit",
		smtpUtf8: false,
		requireTLS: false,
	};
	if (!ctx.server.options.hideDSN) {
		s.envelope.dsn = { ret: null, envid: null };
	}
	s.transaction = ctx.transactionCounter + 1;
}

// ---- Socket close / error --------------------------------------------------

export function closeSocket(ctx: ConnectionContext): void {
	if (!ctx.closed && !ctx.closing) {
		ctx.closing = true;
		ctx.socket.end();
	}
}

export function handleClose(ctx: ConnectionContext): void {
	ctx.parser.isClosed = true;

	if (ctx.dataController) {
		try {
			ctx.dataController.error(new Error("Connection closed"));
		} catch {}
		ctx.dataController = null;
	}

	ctx.server.connections.delete(ctx);

	if (ctx.closed) return;
	ctx.closed = true;
	ctx.closing = false;

	clearTimeout(ctx.timeoutHandle ?? undefined);

	setImmediate(() => ctx.server.onClose(ctx.session));

	// Notify server.close() that a connection drained
	if (ctx.server.closing) {
		ctx.server._notifyConnectionClosed();
	}
}

export function handleError(ctx: ConnectionContext, err: SMTPError): void {
	// Ignore dirty disconnects outside an active transaction
	if (
		(err.code === "ECONNRESET" || err.code === "EPIPE") &&
		!ctx.session.envelope.mailFrom
	) {
		closeSocket(ctx);
		return;
	}
	ctx.server.emit("error", err);
}

// ---- Timeout ---------------------------------------------------------------

function resetTimeout(ctx: ConnectionContext): void {
	ctx.lastActivity = Date.now();
	if (!ctx.timeoutHandle) {
		ctx.timeoutHandle = setTimeout(
			() => tickTimeout(ctx),
			ctx.server.options.socketTimeout ?? SOCKET_TIMEOUT,
		);
	}
}

function tickTimeout(ctx: ConnectionContext): void {
	ctx.timeoutHandle = null;
	if (ctx.closed || ctx.closing) return;
	const socketTimeout = ctx.server.options.socketTimeout ?? SOCKET_TIMEOUT;
	const remaining = socketTimeout - (Date.now() - ctx.lastActivity);
	if (remaining <= 0) {
		sendRaw(ctx, buildResponse(ctx, 421, "Timeout - closing connection"));
	} else {
		ctx.timeoutHandle = setTimeout(() => tickTimeout(ctx), remaining);
	}
}

// ---- Reverse DNS -----------------------------------------------------------

async function reverseResolve(ctx: ConnectionContext): Promise<string> {
	if (ctx.server.options.disableReverseLookup) {
		return `[${ctx.remoteAddress}]`;
	}

	const timeoutMs = 1500;
	const fallback = `[${ctx.remoteAddress}]`;

	try {
		const result = await Promise.race([
			doReverse(ctx),
			new Promise<string[]>((_, reject) => {
				const t = setTimeout(() => reject(new Error("Timeout")), timeoutMs);
				if (typeof t.unref === "function") t.unref();
			}),
		]);
		return (Array.isArray(result) ? result[0] : result) ?? fallback;
	} catch {
		return fallback;
	}
}

function doReverse(ctx: ConnectionContext): Promise<string[]> {
	if (ctx.server.options.resolver?.reverse) {
		return new Promise((resolve, reject) => {
			ctx.server.options.resolver?.reverse(
				ctx.remoteAddress,
				(err, hostnames) => {
					if (err) reject(err);
					else resolve(hostnames ?? []);
				},
			);
		});
	}
	return new Promise((resolve, reject) => {
		// Use node:dns which Bun polyfills with c-ares
		import("node:dns").then(({ reverse }) => {
			reverse(ctx.remoteAddress, (err, hostnames) => {
				if (err) reject(err);
				else resolve(hostnames);
			});
		});
	});
}

// ---- Connection event -------------------------------------------------------

function emitConnection(ctx: ConnectionContext): void {
	if (!ctx.canEmitConnection) return;
	ctx.canEmitConnection = false;
	ctx.server.emit("connect", {
		id: ctx.id,
		localAddress: ctx.localAddress,
		localPort: ctx.localPort,
		remoteAddress: ctx.remoteAddress,
		remotePort: ctx.remotePort,
		hostNameAppearsAs: ctx.hostNameAppearsAs,
		clientHostname: ctx.clientHostname,
	});
}

// ---- MAIL FROM param validation/application --------------------------------

function validateMailParams(
	ctx: ConnectionContext,
	parsed: SMTPAddress,
): { code: number; message: string } | null {
	if (!parsed.args) return null;

	if (parsed.args.BODY) {
		const body = (parsed.args.BODY as string).toUpperCase();
		if (body !== "7BIT" && body !== "8BITMIME") {
			return { code: 501, message: "Error: Unknown BODY parameter value" };
		}
	}

	if (parsed.args.SMTPUTF8 === true && ctx.server.options.hideSMTPUTF8) {
		return { code: 555, message: "Error: SMTPUTF8 is not supported" };
	}

	if (parsed.args.REQUIRETLS !== undefined) {
		if (parsed.args.REQUIRETLS !== true) {
			return {
				code: 501,
				message:
					"Invalid REQUIRETLS parameter. This flag does not accept a value",
			};
		}
	}

	if (!ctx.server.options.hideDSN && parsed.args.RET) {
		const ret = (parsed.args.RET as string).toUpperCase();
		if (ret !== "FULL" && ret !== "HDRS") {
			return {
				code: 501,
				message: "Invalid RET parameter value. Must be FULL or HDRS",
			};
		}
	}

	return null;
}

function applyMailParams(ctx: ConnectionContext, parsed: SMTPAddress): void {
	if (!parsed.args) return;

	if (parsed.args.BODY) {
		ctx.session.envelope.bodyType = (
			parsed.args.BODY as string
		).toLowerCase() as "7bit" | "8bitmime";
	}
	if (parsed.args.SMTPUTF8 === true) {
		ctx.session.envelope.smtpUtf8 = true;
	}
	if (parsed.args.REQUIRETLS === true) {
		ctx.session.envelope.requireTLS = true;
	}
	if (!ctx.server.options.hideDSN && ctx.session.envelope.dsn) {
		if (parsed.args.RET) {
			ctx.session.envelope.dsn.ret = (
				parsed.args.RET as string
			).toUpperCase() as "FULL" | "HDRS";
		}
		if (parsed.args.ENVID) {
			ctx.session.envelope.dsn.envid = parsed.args.ENVID as string;
		}
	}
}
