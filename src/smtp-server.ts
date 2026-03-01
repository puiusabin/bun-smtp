/**
 * SMTPServer — drop-in TypeScript/Bun replacement for the smtp-server npm package.
 *
 * Uses Bun.listen() for TCP, socket.upgradeTLS() for STARTTLS, and Web ReadableStream
 * for the DATA phase. All user-facing callbacks (onAuth, onData, etc.) match the
 * original smtp-server API.
 */

import { hostname } from "node:os";
import type { TCPSocketListener } from "bun";
import {
	closeSocket,
	createContext,
	enqueueChunk,
	handleClose,
	handleError,
	initConnection,
} from "./connection.ts";
import type {
	ConnectionContext,
	OnAuthCallback,
	OnCloseCallback,
	OnConnectCallback,
	OnDataCallback,
	OnMailFromCallback,
	OnRcptToCallback,
	OnSecureCallback,
	ServerInstance,
	SMTPError,
	SMTPServerEventMap,
	SMTPServerOptions,
} from "./types.ts";

// Default development TLS cert (self-signed localhost, from smtp-server/lib/tls-options.js)
const DEFAULT_TLS_KEY =
	"-----BEGIN RSA PRIVATE KEY-----\n" +
	"MIIEpAIBAAKCAQEA6Z5Qqhw+oWfhtEiMHE32Ht94mwTBpAfjt3vPpX8M7DMCTwHs\n" +
	"1xcXvQ4lQ3rwreDTOWdoJeEEy7gMxXqH0jw0WfBx+8IIJU69xstOyT7FRFDvA1yT\n" +
	"RXY2yt9K5s6SKken/ebMfmZR+03ND4UFsDzkz0FfgcjrkXmrMF5Eh5UXX/+9YHeU\n" +
	"xlp0gMAt+/SumSmgCaysxZLjLpd4uXz+X+JVxsk1ACg1NoEO7lWJC/3WBP7MIcu2\n" +
	"wVsMd2XegLT0gWYfT1/jsIH64U/mS/SVXC9QhxMl9Yfko2kx1OiYhDxhHs75RJZh\n" +
	"rNRxgfiwgSb50Gw4NAQaDIxr/DJPdLhgnpY6UQIDAQABAoIBAE+tfzWFjJbgJ0ql\n" +
	"s6Ozs020Sh4U8TZQuonJ4HhBbNbiTtdDgNObPK1uNadeNtgW5fOeIRdKN6iDjVeN\n" +
	"AuXhQrmqGDYVZ1HSGUfD74sTrZQvRlWPLWtzdhybK6Css41YAyPFo9k4bJ2ZW2b/\n" +
	"p4EEQ8WsNja9oBpttMU6YYUchGxo1gujN8hmfDdXUQx3k5Xwx4KA68dveJ8GasIt\n" +
	"d+0Jd/FVwCyyx8HTiF1FF8QZYQeAXxbXJgLBuCsMQJghlcpBEzWkscBR3Ap1U0Zi\n" +
	"4oat8wrPZGCblaA6rNkRUVbc/+Vw0stnuJ/BLHbPxyBs6w495yBSjBqUWZMvljNz\n" +
	"m9/aK0ECgYEA9oVIVAd0enjSVIyAZNbw11ElidzdtBkeIJdsxqhmXzeIFZbB39Gd\n" +
	"bjtAVclVbq5mLsI1j22ER2rHA4Ygkn6vlLghK3ZMPxZa57oJtmL3oP0RvOjE4zRV\n" +
	"dzKexNGo9gU/x9SQbuyOmuauvAYhXZxeLpv+lEfsZTqqrvPUGeBiEQcCgYEA8poG\n" +
	"WVnykWuTmCe0bMmvYDsWpAEiZnFLDaKcSbz3O7RMGbPy1cypmqSinIYUpURBT/WY\n" +
	"wVPAGtjkuTXtd1Cy58m7PqziB7NNWMcsMGj+lWrTPZ6hCHIBcAImKEPpd+Y9vGJX\n" +
	"oatFJguqAGOz7rigBq6iPfeQOCWpmprNAuah++cCgYB1gcybOT59TnA7mwlsh8Qf\n" +
	"bm+tSllnin2A3Y0dGJJLmsXEPKtHS7x2Gcot2h1d98V/TlWHe5WNEUmx1VJbYgXB\n" +
	"pw8wj2ACxl4ojNYqWPxegaLd4DpRbtW6Tqe9e47FTnU7hIggR6QmFAWAXI+09l8y\n" +
	"amssNShqjE9lu5YDi6BTKwKBgQCuIlKGViLfsKjrYSyHnajNWPxiUhIgGBf4PI0T\n" +
	"/Jg1ea/aDykxv0rKHnw9/5vYGIsM2st/kR7l5mMecg/2Qa145HsLfMptHo1ZOPWF\n" +
	"9gcuttPTegY6aqKPhGthIYX2MwSDMM+X0ri6m0q2JtqjclAjG7yG4CjbtGTt/UlE\n" +
	"WMlSZwKBgQDslGeLUnkW0bsV5EG3AKRUyPKz/6DVNuxaIRRhOeWVKV101claqXAT\n" +
	"wXOpdKrvkjZbT4AzcNrlGtRl3l7dEVXTu+dN7/ZieJRu7zaStlAQZkIyP9O3DdQ3\n" +
	"rIcetQpfrJ1cAqz6Ng0pD0mh77vQ13WG1BBmDFa2A9BuzLoBituf4g==\n" +
	"-----END RSA PRIVATE KEY-----";

const DEFAULT_TLS_CERT =
	"-----BEGIN CERTIFICATE-----\n" +
	"MIICpDCCAYwCCQCuVLVKVTXnAjANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDEwls\n" +
	"b2NhbGhvc3QwHhcNMTUwMjEyMTEzMjU4WhcNMjUwMjA5MTEzMjU4WjAUMRIwEAYD\n" +
	"VQQDEwlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDp\n" +
	"nlCqHD6hZ+G0SIwcTfYe33ibBMGkB+O3e8+lfwzsMwJPAezXFxe9DiVDevCt4NM5\n" +
	"Z2gl4QTLuAzFeofSPDRZ8HH7wgglTr3Gy07JPsVEUO8DXJNFdjbK30rmzpIqR6f9\n" +
	"5sx+ZlH7Tc0PhQWwPOTPQV+ByOuReaswXkSHlRdf/71gd5TGWnSAwC379K6ZKaAJ\n" +
	"rKzFkuMul3i5fP5f4lXGyTUAKDU2gQ7uVYkL/dYE/swhy7bBWwx3Zd6AtPSBZh9P\n" +
	"X+OwgfrhT+ZL9JVcL1CHEyX1h+SjaTHU6JiEPGEezvlElmGs1HGB+LCBJvnQbDg0\n" +
	"BBoMjGv8Mk90uGCeljpRAgMBAAEwDQYJKoZIhvcNAQELBQADggEBABXm8GPdY0sc\n" +
	"mMUFlgDqFzcevjdGDce0QfboR+M7WDdm512Jz2SbRTgZD/4na42ThODOZz9z1AcM\n" +
	"zLgx2ZNZzVhBz0odCU4JVhOCEks/OzSyKeGwjIb4JAY7dh+Kju1+6MNfQJ4r1Hza\n" +
	"SVXH0+JlpJDaJ73NQ2JyfqELmJ1mTcptkA/N6rQWhlzycTBSlfogwf9xawgVPATP\n" +
	"4AuwgjHl12JI2HVVs1gu65Y3slvaHRCr0B4+Kg1GYNLLcbFcK+NEHrHmPxy9TnTh\n" +
	"Zwp1dsNQU+Xkylz8IUANWSLHYZOMtN2e5SKIdwTtl5C8YxveuY8YKb1gDExnMraT\n" +
	"VGXQDqPleug=\n" +
	"-----END CERTIFICATE-----";

// ---- Default no-op handlers ------------------------------------------------

const defaultOnConnect: OnConnectCallback = (_session, cb) => cb();
const defaultOnSecure: OnSecureCallback = (_socket, _session, cb) => cb();
const defaultOnAuth: OnAuthCallback = (_auth, _session, cb) =>
	cb(
		Object.assign(new Error("Error: Authentication not implemented"), {
			responseCode: 535,
		}),
	);
const defaultOnMailFrom: OnMailFromCallback = (_addr, _session, cb) => cb();
const defaultOnRcptTo: OnRcptToCallback = (_addr, _session, cb) => cb();
const defaultOnData: OnDataCallback = (stream, _session, cb) => {
	// Drain and discard
	const reader = stream.getReader();
	const drain = (): void => {
		reader
			.read()
			.then(({ done }) => {
				if (!done) drain();
				else cb(null);
			})
			.catch(cb);
	};
	drain();
};
const defaultOnClose: OnCloseCallback = (_session) => {};

// ---- SMTPServer ------------------------------------------------------------

export class SMTPServer implements ServerInstance {
	options: ServerInstance["options"];
	connections: Set<ConnectionContext> = new Set();
	closing = false;
	disabledCommandsSet: Set<string> = new Set();
	tlsKey: string;
	tlsCert: string;

	// Hooks (can be overridden as methods or set via options)
	onConnect: OnConnectCallback;
	onSecure: OnSecureCallback;
	onAuth: OnAuthCallback;
	onMailFrom: OnMailFromCallback;
	onRcptTo: OnRcptToCallback;
	onData: OnDataCallback;
	onClose: OnCloseCallback;

	private _listener: TCPSocketListener<ConnectionContext> | null = null;
	private _closeTimeout: ReturnType<typeof setTimeout> | null = null;
	private _closeCheckFn: (() => void) | null = null;
	private _ev = new Map<string, Set<(...args: never[]) => void>>();

	on<K extends keyof SMTPServerEventMap>(
		event: K,
		listener: (...args: SMTPServerEventMap[K]) => void,
	): this {
		let s = this._ev.get(event);
		if (!s) {
			s = new Set();
			this._ev.set(event, s);
		}
		s.add(listener as never);
		return this;
	}

	off<K extends keyof SMTPServerEventMap>(
		event: K,
		listener: (...args: SMTPServerEventMap[K]) => void,
	): this {
		this._ev.get(event)?.delete(listener as never);
		return this;
	}

	once<K extends keyof SMTPServerEventMap>(
		event: K,
		listener: (...args: SMTPServerEventMap[K]) => void,
	): this {
		const w = (...args: SMTPServerEventMap[K]) => {
			this.off(event, w);
			listener(...args);
		};
		return this.on(event, w as never);
	}

	emit<K extends keyof SMTPServerEventMap>(
		event: K,
		...args: SMTPServerEventMap[K]
	): void {
		for (const fn of this._ev.get(event) ?? [])
			(fn as (...a: SMTPServerEventMap[K]) => void)(...args);
	}

	_notifyConnectionClosed(): void {
		this._closeCheckFn?.();
	}

	constructor(options: SMTPServerOptions = {}) {
		const defaults: ServerInstance["options"] = {
			secure: false,
			needsUpgrade: false,
			name: hostname(),
			banner: "",
			lmtp: false,
			authMethods: ["LOGIN", "PLAIN"],
			authOptional: false,
			allowInsecureAuth: false,
			authRequiredMessage: "",
			disabledCommands: [],
			hideSTARTTLS: false,
			hideSize: false,
			hidePIPELINING: false,
			hideDSN: true,
			hideENHANCEDSTATUSCODES: true,
			hideREQUIRETLS: true,
			hide8BITMIME: false,
			hideSMTPUTF8: false,
			size: 0,
			maxClients: 0,
			maxAllowedUnauthenticatedCommands: 10,
			socketTimeout: 60_000,
			closeTimeout: 30_000,
			useXClient: false,
			useXForward: false,
			disableReverseLookup: false,
			heloResponse: "",
		};

		this.options = { ...defaults, ...options } as ServerInstance["options"];
		this.disabledCommandsSet = new Set(
			(this.options.disabledCommands ?? []).map((c) => c.toUpperCase()),
		);

		// Apply callbacks from options (if provided)
		this.onConnect = options.onConnect ?? defaultOnConnect;
		this.onSecure = options.onSecure ?? defaultOnSecure;
		this.onAuth = options.onAuth ?? defaultOnAuth;
		this.onMailFrom = options.onMailFrom ?? defaultOnMailFrom;
		this.onRcptTo = options.onRcptTo ?? defaultOnRcptTo;
		this.onData = options.onData ?? defaultOnData;
		this.onClose = options.onClose ?? defaultOnClose;

		this.tlsKey = (options.key as string | undefined) ?? DEFAULT_TLS_KEY;
		this.tlsCert = (options.cert as string | undefined) ?? DEFAULT_TLS_CERT;
	}

	/**
	 * Start listening. Arguments are forwarded to Bun.listen().
	 * Supports:
	 *   server.listen(port)
	 *   server.listen(port, hostname)
	 *   server.listen({ port, hostname })
	 *   server.listen(port, hostname, callback)
	 */
	listen(port: number, callback?: () => void): this;
	listen(port: number, host: string, callback?: () => void): this;
	listen(
		options: { port?: number; host?: string; hostname?: string },
		callback?: () => void,
	): this;
	listen(...args: unknown[]): this {
		let port = 0;
		let listenHost = "0.0.0.0";
		let callback: (() => void) | undefined;

		for (const arg of args) {
			if (typeof arg === "number") port = arg;
			else if (typeof arg === "string") listenHost = arg;
			else if (typeof arg === "function") callback = arg as () => void;
			else if (typeof arg === "object" && arg !== null) {
				const opts = arg as Record<string, unknown>;
				if (opts.port) port = Number(opts.port);
				if (opts.host || opts.hostname)
					listenHost = String(opts.host ?? opts.hostname);
			}
		}

		const server = this;

		const tls =
			this.options.secure || this.options.needsUpgrade
				? { key: this.tlsKey, cert: this.tlsCert }
				: undefined;

		this._listener = Bun.listen<ConnectionContext>({
			hostname: listenHost,
			port,
			tls,
			socket: {
				open(socket) {
					const ctx = createContext(server, socket);
					socket.data = ctx;
					server.connections.add(ctx);

					if (
						server.options.maxClients &&
						server.connections.size > server.options.maxClients
					) {
						socket.write(
							`421 ${server.options.name} Too many connected clients, try again in a moment\r\n`,
						);
						socket.end();
						server.connections.delete(ctx);
						return;
					}

					initConnection(ctx);
				},

				data(socket, chunk) {
					const ctx = socket.data;
					const buf = Buffer.from(chunk);
					// Data-mode chunks bypass the command queue to avoid deadlocking the
					// drain loop (which is suspended while awaiting the onData callback).
					if (ctx.parser.dataMode) {
						ctx.parser.feedDataMode(buf);
					} else {
						enqueueChunk(ctx, buf);
					}
				},

				close(socket) {
					handleClose(socket.data);
				},

				error(socket, err) {
					handleError(socket.data, err as SMTPError);
				},
			},
		});

		if (callback) {
			setImmediate(callback);
		}

		setImmediate(() => this.emit("listening"));
		return this;
	}

	/**
	 * Gracefully close the server.
	 * Waits up to closeTimeout for active connections to finish, then force-closes.
	 */
	close(callback?: () => void): this {
		this.closing = true;

		if (this._listener) {
			this._listener.stop(false);
			this._listener = null;
		}

		if (this.connections.size === 0) {
			setImmediate(() => {
				this.emit("close");
				callback?.();
			});
			return this;
		}

		const timeout = this.options.closeTimeout ?? 30_000;
		this._closeTimeout = setTimeout(() => {
			for (const ctx of this.connections) {
				ctx.socket.write("421 Server shutting down\r\n");
				closeSocket(ctx);
			}
		}, timeout);

		const checkDone = (): void => {
			if (this.connections.size === 0) {
				this._closeCheckFn = null;
				if (this._closeTimeout) {
					clearTimeout(this._closeTimeout);
					this._closeTimeout = null;
				}
				this.emit("close");
				callback?.();
			}
		};

		this._closeCheckFn = checkDone;
		return this;
	}

	/**
	 * Hot-reload TLS certificates without restarting the server.
	 */
	updateSecureContext(
		options: Pick<SMTPServerOptions, "key" | "cert" | "ca">,
	): void {
		if (options.key) this.tlsKey = options.key as string;
		if (options.cert) this.tlsCert = options.cert as string;
		// Bun doesn't expose a way to hot-reload the TLS context on an existing listener,
		// so new connections will pick up the updated key/cert automatically via
		// socket.upgradeTLS() calls in the STARTTLS handler.
	}
}
