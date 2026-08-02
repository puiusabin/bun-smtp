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

// Default development TLS cert (self-signed localhost, regenerated 2026-08-02 —
// the original smtp-server/lib/tls-options.js fixture expired 2025-02-09, which
// silently broke STARTTLS for anyone not supplying their own key/cert). Valid
// until 2036-07-30.
const DEFAULT_TLS_KEY =
	"-----BEGIN RSA PRIVATE KEY-----\n" +
	"MIIEogIBAAKCAQEAnyNsc7fNikJSmvucttzKZ8Fmuz/V4Daso6oQFKz3Azovd0ob\n" +
	"/wCkUqt6PG2YcEZXlObgDFHxwszjKqWpelABg9QUNehXNC8xe9Ca5L7OsBeR1Cs+\n" +
	"NZ0ILv9TQHXKFCqMm8DjSrBOqq+FftFjh9UyX59jJBycCq9I5gNOA8AJhLlJamRD\n" +
	"nHlRl1R4YXAEpVWyqA70NcOoKu5tIAJJbn+lFvTP78Wz5RkXDQA2TPD1pmQj8h8T\n" +
	"9tDeV6AmVfh3VRf4nNBexdFP884JaIIfnsYQQBf7PPg2BK5yB6PgUfog8viEkbEt\n" +
	"xOywt2xJhnHacdXiPVKP6DP2Ad7nPXhP1fXGcQIDAQABAoH/bY+12vVwTP/cX1db\n" +
	"TYo0z7oXQFNyrCr4MLWk3Jc4eMBWbYpYO/f1KfVk8rWBfcrwAVPybIj+KV9mBraH\n" +
	"N+5dHKWmRHbxkrvrFZNJELNNGW8gtzIOYlr6h2DBsF9oAPpKU/E4ivNXNawh/G2s\n" +
	"WJgvViYl23bW94Q2bCVaULql0vmnrPHN9PwP7zRE4TLJFCZhiQgieW3vcqUSLlTh\n" +
	"BEjXeQ2itvSUi2t8K2C7SW4qYZMPNG9jNyHMJrkxo5V7l+AhNN7cyNokyHo4WZKg\n" +
	"x6ss6LMsORVmNNhN3e2EFkceKWHJsRw3iiAfGTpUyo4fAUk2STV2amSoMJBQtTG9\n" +
	"rPDdAoGBANIHRqyQyRYmUEU3tmk2bl60xdNoFEifUb4wl4pebN3eF+JRsWAIkfLG\n" +
	"MJdCknaDypnXCzRfsQLY3EoLCxLVNC88caacnFymmLnZW8eo4jZd9oIKxGrvx9s8\n" +
	"26vPX/tBcyPH/BEMjRA40raqBAOy67HRR+9T0sNNqV1GTT/uEwWNAoGBAMH4k6IV\n" +
	"EpwmMJFz2VJoGSJMA4Z35T8K83EYOl09lsvuk2uYIyZ4q2kjyZeJ887usCOpysCB\n" +
	"rADZJtqtSuaaPYRDrt5tKW9K2oakJgM0R2k0A5Qt1e4/B/sRnePgOUJ3yP3pcm40\n" +
	"bTEN42OgreAZd32phhcjqKCb7C5tiBhyVXF1AoGBAKo1q1j+nXiN5E+0LuhlbFzk\n" +
	"M854crfIJf70clt42tGTw9duTUl+qIkPhSGQmhHiDLdQR4xSYKnmBeEbwgWpM3l0\n" +
	"isZz9WRAv1UeifrtKybUT4pkH3pqiJVsZLqAfVCqYh2FXQqUGV4kLuBKOKamwcyB\n" +
	"xsJ2NECDF9a3urMsxc2hAoGAGq0J+K93OLxTz50kFR413q6fiX2xrGLgKfyQAkS3\n" +
	"GWK9KX3pz5+myzXdwpZ5TksrNCxksubidddnbYmJlH8/2JHKWdKfcSvVM9EdXTFy\n" +
	"ZLh/iYBoPHS0r0Wz9iPfHBIHNUxGrXtOTQHA9PGjF//InCKVS1dfGH95EsWDgwEu\n" +
	"WQUCgYEAxZuG+TuBQei0zz/SqpQu5ucCLP217CwqPLM6JKPl96NXw9oKFsTdUhNg\n" +
	"9+Xrud2IdbddKlYrvgyxL9PgC331i6LSDBg5v5JGjBdpR3iULjKocAnEDt0IlLSk\n" +
	"3pUqmK2j2oBst4Bb9hhdKfq1nlRJ7dsdcNPUyIV9fOJvtJW9+rY=\n" +
	"-----END RSA PRIVATE KEY-----";

const DEFAULT_TLS_CERT =
	"-----BEGIN CERTIFICATE-----\n" +
	"MIIDCTCCAfGgAwIBAgIUS4QGr1H/dLasDI0BGghF+CLqVa0wDQYJKoZIhvcNAQEL\n" +
	"BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgwMjExMjA1NFoXDTM2MDcz\n" +
	"MDExMjA1NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\n" +
	"AAOCAQ8AMIIBCgKCAQEAnyNsc7fNikJSmvucttzKZ8Fmuz/V4Daso6oQFKz3Azov\n" +
	"d0ob/wCkUqt6PG2YcEZXlObgDFHxwszjKqWpelABg9QUNehXNC8xe9Ca5L7OsBeR\n" +
	"1Cs+NZ0ILv9TQHXKFCqMm8DjSrBOqq+FftFjh9UyX59jJBycCq9I5gNOA8AJhLlJ\n" +
	"amRDnHlRl1R4YXAEpVWyqA70NcOoKu5tIAJJbn+lFvTP78Wz5RkXDQA2TPD1pmQj\n" +
	"8h8T9tDeV6AmVfh3VRf4nNBexdFP884JaIIfnsYQQBf7PPg2BK5yB6PgUfog8viE\n" +
	"kbEtxOywt2xJhnHacdXiPVKP6DP2Ad7nPXhP1fXGcQIDAQABo1MwUTAdBgNVHQ4E\n" +
	"FgQUYr5Jg06e8MNG+wOPeIuhRlhCtycwHwYDVR0jBBgwFoAUYr5Jg06e8MNG+wOP\n" +
	"eIuhRlhCtycwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAHivq\n" +
	"7LrbkE3jZT3dH9/whv0qN3O9Shpaw3wyrIax5SmJTDieFf/Uvv8T5eVjfnMnDXzg\n" +
	"VwxkVcRzjDNxLgizokGS7pKOI2zmYZzuxzCUUrqrOUAXkVQTZT/jGd55ILSqftGX\n" +
	"pvuUA7lIbpo2cEIruYXWdv1AowcmaIBKhrbGX5MAwSkdh5E6oBHspw6a3OkfbXfk\n" +
	"FpOsaWV77A1XKY7v8NuRPA6i7ZuSVbgZjuwNs+6rd1QuSpvIZU6dDsxxDGqaBFfY\n" +
	"slg0UjtwfIUB2T4jLxy5Qv1VKs+hIgUNhexKMpide7gDy0FreYIfn8AoGwmvgOJk\n" +
	"D/wiTbnQMCuob2DTmg==\n" +
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

		const tls = this.options.secure
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
					// Ignore raw encrypted bytes once TLS upgrade is in progress or done.
					// The TLS socket handler (in the STARTTLS command) handles decrypted data.
					if (ctx.upgrading || ctx.tlsUpgraded) return;
					// Data-mode chunks bypass the command queue to avoid deadlocking the
					// drain loop (which is suspended while awaiting the onData callback).
					if (ctx.parser.dataMode) {
						ctx.parser.feedDataMode(chunk);
					} else {
						enqueueChunk(ctx, chunk);
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
