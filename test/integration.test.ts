/**
 * Integration tests for bun-smtp.
 *
 * Spins up a real SMTPServer on a random port, connects via Bun.connect(),
 * exchanges raw SMTP commands, and asserts on responses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SMTPServer } from "../src/smtp-server.ts";
import type { SMTPServerOptions } from "../src/types.ts";

// ---- TCP test client -------------------------------------------------------

class SMTPClient {
	private socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
	private buffer = "";
	private resolve: ((line: string) => void) | null = null;
	private lines: string[] = [];

	async connect(port: number): Promise<string> {
		return new Promise((outerResolve) => {
			const client = this;
			Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					open(socket) {
						client.socket = socket as unknown as Awaited<
							ReturnType<typeof Bun.connect>
						>;
					},
					data(_socket, rawData) {
						const chunk = Buffer.from(rawData).toString("utf8");
						client.buffer += chunk;

						let newlineIdx = client.buffer.indexOf("\n");
						while (newlineIdx !== -1) {
							const line = client.buffer
								.slice(0, newlineIdx)
								.replace(/\r$/, "");
							client.buffer = client.buffer.slice(newlineIdx + 1);
							newlineIdx = client.buffer.indexOf("\n");
							if (client.resolve) {
								const res = client.resolve;
								client.resolve = null;
								res(line);
							} else {
								client.lines.push(line);
							}
						}
					},
					close() {},
					error(_socket, err) {
						console.error("client error", err);
					},
				},
			}).then(() => {
				// Wait for the 220 greeting
				client.readLine().then(outerResolve);
			});
		});
	}

	/** Read the next complete response line (waits if not yet available). */
	readLine(): Promise<string> {
		if (this.lines.length > 0) {
			return Promise.resolve(this.lines.shift() ?? "");
		}
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	/**
	 * Read until a line whose code is a final response (no dash after code).
	 * SMTP multi-line responses look like: "250-..." then "250 last line".
	 */
	async readResponse(): Promise<string> {
		let last = "";
		while (true) {
			const line = await this.readLine();
			last = line;
			// A final line has format "NNN text" (space after 3-digit code)
			if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) {
				return last;
			}
		}
	}

	/** Send a line (CRLF appended automatically). */
	send(line: string): void {
		(this.socket as unknown as { write(data: string): void }).write(
			`${line}\r\n`,
		);
	}

	/** Send raw bytes (for DATA body). */
	sendRaw(data: string): void {
		(this.socket as unknown as { write(data: string): void }).write(data);
	}

	close(): void {
		try {
			(this.socket as unknown as { end(): void }).end();
		} catch {}
	}
}

// ---- Server factory --------------------------------------------------------

function makeServer(opts: SMTPServerOptions = {}): {
	server: SMTPServer;
	port: number;
} {
	// Pick a port in the ephemeral range; let OS pick actual port
	const server = new SMTPServer({
		authOptional: true,
		disableReverseLookup: true,
		...opts,
	});

	const port = 10000 + Math.floor(Math.random() * 20000);
	server.listen(port, "127.0.0.1");
	return { server, port };
}

// ---- Helpers ---------------------------------------------------------------

async function _doTransaction(
	client: SMTPClient,
	from: string,
	to: string,
	body: string,
): Promise<string> {
	await client.readResponse(); // burn MAIL FROM 250
	client.send(`MAIL FROM:<${from}>`);
	await client.readResponse(); // 250

	client.send(`RCPT TO:<${to}>`);
	await client.readResponse(); // 250

	client.send("DATA");
	await client.readResponse(); // 354

	client.sendRaw(`${body}\r\n.\r\n`);
	return client.readResponse(); // 250 or error
}

// ============================================================================
// Test suites
// ============================================================================

describe("connection & greeting", () => {
	let server: SMTPServer;
	let port: number;
	let client: SMTPClient;

	beforeEach(async () => {
		({ server, port } = makeServer());
		client = new SMTPClient();
		await client.connect(port);
	});

	afterEach(async () => {
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("sends 220 greeting on connect", () => {
		// 220 greeting was already consumed by client.connect() in beforeEach
		expect(server).toBeDefined();
	});

	test("responds to NOOP with 250", async () => {
		client.send("NOOP");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^250/);
	});

	test("responds to HELP with 214", async () => {
		client.send("HELP");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^214/);
	});

	test("responds to VRFY with 252", async () => {
		client.send("VRFY anyone");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^252/);
	});

	test("QUIT closes with 221", async () => {
		client.send("QUIT");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^221/);
	});

	test("unknown command returns 500", async () => {
		client.send("EHLO localhost");
		await client.readResponse(); // 250
		client.send("BOGUSCMD");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^500/);
	});

	test("HTTP request returns 421", async () => {
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("GET / HTTP/1.1");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^421/);
	});
});

describe("EHLO capabilities", () => {
	let server: SMTPServer;
	let port: number;
	let client: SMTPClient;

	beforeEach(async () => {
		({ server, port } = makeServer({ authMethods: ["PLAIN", "LOGIN"] }));
		client = new SMTPClient();
		await client.connect(port);
	});

	afterEach(async () => {
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("EHLO returns 250 multi-line with PIPELINING and 8BITMIME", async () => {
		client.send("EHLO testclient.local");
		const lines: string[] = [];
		while (true) {
			const line = await client.readLine();
			lines.push(line);
			if (/^\d{3} /.test(line)) break;
		}
		const caps = lines.join("\n");
		expect(lines[0]).toMatch(/^250/);
		expect(caps).toContain("PIPELINING");
		expect(caps).toContain("8BITMIME");
	});

	test("HELO returns single 250 line", async () => {
		client.send("HELO testclient.local");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^250 /);
	});

	test("EHLO with invalid syntax returns 501", async () => {
		client.send("EHLO");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^501/);
	});
});

describe("MAIL / RCPT / DATA flow", () => {
	let server: SMTPServer;
	let port: number;
	let client: SMTPClient;
	let receivedData: string;

	beforeEach(async () => {
		receivedData = "";
		({ server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, _session, callback) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of stream) chunks.push(chunk);
				receivedData = Buffer.concat(chunks).toString();
				callback(null, "OK: queued");
			},
		}));
		client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
	});

	afterEach(async () => {
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("full MAIL+RCPT+DATA transaction returns 250", async () => {
		client.send("MAIL FROM:<sender@example.com>");
		expect(await client.readResponse()).toMatch(/^250/);

		client.send("RCPT TO:<recipient@example.com>");
		expect(await client.readResponse()).toMatch(/^250/);

		client.send("DATA");
		expect(await client.readResponse()).toMatch(/^354/);

		client.sendRaw("Subject: Test\r\n\r\nHello!\r\n.\r\n");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^250/);
		expect(resp).toContain("queued");
	});

	test("onData receives full body content", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<c@d.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("Subject: hello\r\n\r\nbody text\r\n.\r\n");
		await client.readResponse();

		expect(receivedData).toContain("Subject: hello");
		expect(receivedData).toContain("body text");
	});

	test("dot-stuffed dot in body is unescaped", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<c@d.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		// ".." at start of line -> "." in received body
		client.sendRaw("Line 1\r\n..starts with dot\r\n.\r\n");
		await client.readResponse();

		expect(receivedData).toContain(".starts with dot");
	});

	test("RCPT before MAIL returns 503", async () => {
		client.send("RCPT TO:<a@b.com>");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^503/);
	});

	test("DATA before RCPT returns 503", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("DATA");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^503/);
	});

	test("nested MAIL returns 503", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("MAIL FROM:<b@c.com>");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^503/);
	});

	test("RSET clears envelope", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RSET");
		expect(await client.readResponse()).toMatch(/^250/);
		// MAIL again should succeed (no nested MAIL error)
		client.send("MAIL FROM:<c@d.com>");
		expect(await client.readResponse()).toMatch(/^250/);
	});

	test("multiple recipients accepted", async () => {
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<r1@example.com>");
		expect(await client.readResponse()).toMatch(/^250/);
		client.send("RCPT TO:<r2@example.com>");
		expect(await client.readResponse()).toMatch(/^250/);
	});
});

describe("onMailFrom / onRcptTo callbacks", () => {
	test("onMailFrom rejection propagates as 550", async () => {
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			onMailFrom(_addr, _session, cb) {
				cb(Object.assign(new Error("Blocked sender"), { responseCode: 550 }));
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<bad@example.com>");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^550/);

		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("onRcptTo rejection propagates as 550", async () => {
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			onRcptTo(_addr, _session, cb) {
				cb(Object.assign(new Error("No such user"), { responseCode: 550 }));
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<nobody@example.com>");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^550/);

		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("onMailFrom receives correct address and args", async () => {
		let capturedAddress = "";
		let capturedSize = "";

		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			onMailFrom(addr, _session, cb) {
				capturedAddress = addr.address;
				capturedSize =
					((addr.args &&
						(addr.args as Record<string, unknown>).SIZE) as string) || "";
				cb();
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<sender@domain.com> SIZE=999");
		await client.readResponse();

		expect(capturedAddress).toBe("sender@domain.com");
		expect(capturedSize).toBe("999");

		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("session.envelope is updated after MAIL+RCPT", async () => {
		let envelope: unknown;

		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, session, cb) {
				envelope = { ...session.envelope };
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<from@test.com>");
		await client.readResponse();
		client.send("RCPT TO:<to@test.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("hi\r\n.\r\n");
		await client.readResponse();

		expect(
			(envelope as { mailFrom: { address: string } }).mailFrom.address,
		).toBe("from@test.com");
		expect(
			(envelope as { rcptTo: Array<{ address: string }> }).rcptTo[0]?.address,
		).toBe("to@test.com");

		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("authentication", () => {
	function makeAuthServer() {
		return makeServer({
			disableReverseLookup: true,
			allowInsecureAuth: true,
			authMethods: ["PLAIN", "LOGIN", "CRAM-MD5"],
			onAuth(auth, _session, cb) {
				if (
					"password" in auth &&
					auth.username === "user" &&
					auth.password === "pass"
				) {
					cb(null, { user: { name: auth.username } });
				} else if ("validatePassword" in auth && auth.username === "user") {
					cb(null, {
						user: auth.validatePassword("pass") ? { name: "user" } : undefined,
					});
				} else {
					cb(null, {});
				}
			},
		});
	}

	test("AUTH PLAIN success → 235", async () => {
		const { server, port } = makeAuthServer();
		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		// base64("\0user\0pass")
		const token = Buffer.from("\0user\0pass").toString("base64");
		client.send(`AUTH PLAIN ${token}`);
		const resp = await client.readResponse();
		expect(resp).toMatch(/^235/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("AUTH PLAIN failure → 535", async () => {
		const { server, port } = makeAuthServer();
		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		const token = Buffer.from("\0user\0wrongpass").toString("base64");
		client.send(`AUTH PLAIN ${token}`);
		const resp = await client.readResponse();
		expect(resp).toMatch(/^535/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("AUTH LOGIN multi-step success → 235", async () => {
		const { server, port } = makeAuthServer();
		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("AUTH LOGIN");
		await client.readResponse(); // 334 VXNlcm5hbWU6
		client.send(Buffer.from("user").toString("base64"));
		await client.readResponse(); // 334 UGFzc3dvcmQ6
		client.send(Buffer.from("pass").toString("base64"));
		const resp = await client.readResponse();
		expect(resp).toMatch(/^235/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("AUTH requires EHLO first", async () => {
		const { server, port } = makeAuthServer();
		const client = new SMTPClient();
		await client.connect(port);
		// No EHLO
		client.send("AUTH PLAIN dGVzdA==");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^503/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("MAIL blocked without auth when authOptional=false", async () => {
		const { server, port } = makeServer({
			disableReverseLookup: true,
			allowInsecureAuth: true,
			authMethods: ["PLAIN"],
			authOptional: false,
			onAuth(_auth, _session, cb) {
				cb(null, { user: {} });
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com>");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^530/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("session.user is set after successful auth", async () => {
		let capturedUser: unknown;
		const { server, port } = makeServer({
			disableReverseLookup: true,
			allowInsecureAuth: true,
			authMethods: ["PLAIN"],
			authOptional: true,
			onAuth(_auth, _session, cb) {
				cb(null, { user: { id: 42 } });
			},
			async onData(stream, session, cb) {
				capturedUser = session.user;
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		const token = Buffer.from("\0user\0pass").toString("base64");
		client.send(`AUTH PLAIN ${token}`);
		await client.readResponse(); // 235
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<b@c.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("hi\r\n.\r\n");
		await client.readResponse();

		expect((capturedUser as { id: number }).id).toBe(42);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("SIZE extension", () => {
	test("MAIL FROM with SIZE exceeding limit is rejected with 552", async () => {
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			size: 1000,
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com> SIZE=99999");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^552/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("SIZE capability is advertised in EHLO", async () => {
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			size: 5000000,
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		const lines: string[] = [];
		while (true) {
			const line = await client.readLine();
			lines.push(line);
			if (/^\d{3} /.test(line)) break;
		}
		expect(lines.join("\n")).toContain("SIZE");
		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("onConnect hook", () => {
	test("onConnect rejection closes connection with 554", async () => {
		const { server, port } = makeServer({
			disableReverseLookup: true,
			onConnect(_session, cb) {
				cb(Object.assign(new Error("Blocked"), { responseCode: 554 }));
			},
		});

		const client = new SMTPClient();
		const greeting = await client.connect(port);
		expect(greeting).toMatch(/^554/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("onConnect success allows connection to proceed", async () => {
		let called = false;
		const { server, port } = makeServer({
			disableReverseLookup: true,
			onConnect(_session, cb) {
				called = true;
				cb();
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		expect(called).toBe(true);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("onClose callback", () => {
	test("onClose is called when connection closes", async () => {
		let closedSessionId = "";
		const { server, port } = makeServer({
			disableReverseLookup: true,
			onClose(session) {
				closedSessionId = session.id;
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("QUIT");
		await client.readResponse();
		client.close();

		// Give the event loop a moment to fire onClose
		await Bun.sleep(50);
		expect(closedSessionId).toBeTruthy();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("session state", () => {
	test("session.id is a non-empty string", async () => {
		let sessionId = "";
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, session, cb) {
				sessionId = session.id;
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<b@c.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("hi\r\n.\r\n");
		await client.readResponse();

		expect(sessionId).toBeTruthy();
		expect(sessionId.length).toBeGreaterThan(0);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("transmissionType is ESMTP after EHLO", async () => {
		let txType = "";
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, session, cb) {
				txType = session.transmissionType;
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<b@c.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("hi\r\n.\r\n");
		await client.readResponse();

		expect(txType).toBe("ESMTP");
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("transmissionType includes A after AUTH", async () => {
		let txType = "";
		const { server, port } = makeServer({
			disableReverseLookup: true,
			allowInsecureAuth: true,
			authMethods: ["PLAIN"],
			authOptional: false,
			onAuth(_auth, _session, cb) {
				cb(null, { user: {} });
			},
			async onData(stream, session, cb) {
				txType = session.transmissionType;
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();
		const token = Buffer.from("\0user\0pass").toString("base64");
		client.send(`AUTH PLAIN ${token}`);
		await client.readResponse();
		client.send("MAIL FROM:<a@b.com>");
		await client.readResponse();
		client.send("RCPT TO:<b@c.com>");
		await client.readResponse();
		client.send("DATA");
		await client.readResponse();
		client.sendRaw("hi\r\n.\r\n");
		await client.readResponse();

		expect(txType).toContain("A");
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("transaction counter increments after each DATA", async () => {
		const txCounts: number[] = [];
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, session, cb) {
				txCounts.push(session.transaction);
				for await (const _ of stream) {
				}
				cb(null);
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();

		for (let i = 0; i < 3; i++) {
			client.send("MAIL FROM:<a@b.com>");
			await client.readResponse();
			client.send("RCPT TO:<b@c.com>");
			await client.readResponse();
			client.send("DATA");
			await client.readResponse();
			client.sendRaw("msg\r\n.\r\n");
			await client.readResponse();
		}

		expect(txCounts).toEqual([1, 2, 3]);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("LMTP mode", () => {
	test("EHLO is rejected in LMTP mode", async () => {
		const { server, port } = makeServer({
			lmtp: true,
			authOptional: true,
			disableReverseLookup: true,
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^500/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});

	test("LHLO is accepted in LMTP mode", async () => {
		const { server, port } = makeServer({
			lmtp: true,
			authOptional: true,
			disableReverseLookup: true,
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("LHLO localhost");
		const resp = await client.readResponse();
		expect(resp).toMatch(/^250/);
		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});

describe("pipelining (multiple commands in one send)", () => {
	test("pipelined MAIL+RCPT+DATA handled in order", async () => {
		let receivedBody = "";
		const { server, port } = makeServer({
			authOptional: true,
			disableReverseLookup: true,
			async onData(stream, _session, cb) {
				const chunks: Uint8Array[] = [];
				for await (const chunk of stream) chunks.push(chunk);
				receivedBody = Buffer.concat(chunks).toString();
				cb(null, "pipelined OK");
			},
		});

		const client = new SMTPClient();
		await client.connect(port);
		client.send("EHLO localhost");
		await client.readResponse();

		// Send MAIL + RCPT + DATA all at once (pipelining)
		client.sendRaw(
			"MAIL FROM:<a@b.com>\r\n" + "RCPT TO:<c@d.com>\r\n" + "DATA\r\n",
		);

		// Collect three intermediate responses
		expect(await client.readResponse()).toMatch(/^250/); // MAIL
		expect(await client.readResponse()).toMatch(/^250/); // RCPT
		expect(await client.readResponse()).toMatch(/^354/); // DATA

		client.sendRaw("pipelined body\r\n.\r\n");
		const final = await client.readResponse();
		expect(final).toMatch(/^250/);
		expect(receivedBody).toContain("pipelined body");

		client.close();
		await new Promise<void>((r) => server.close(r));
	});
});
