import { describe, expect, test } from "bun:test";
import type { DataCallbacks } from "../src/smtp-parser.ts";
import { SMTPParser } from "../src/smtp-parser.ts";

// ---- Helpers ---------------------------------------------------------------

function _feedAll(parser: SMTPParser, chunks: Buffer[]): string[] {
	const lines: string[] = [];
	for (const chunk of chunks) {
		lines.push(...parser.feedCommandMode(chunk));
	}
	return lines;
}

interface DataResult {
	chunks: Buffer[];
	byteLength: number;
	sizeExceeded: boolean;
	remainder: Buffer | null;
}

function collectDataMode(
	parser: SMTPParser,
	chunks: Buffer[],
	maxBytes = 0,
): Promise<DataResult> {
	return new Promise((resolve) => {
		const collected: Buffer[] = [];
		let byteLength = 0;
		let sizeExceeded = false;
		let remainder: Buffer | null = null;

		const callbacks: DataCallbacks = {
			onData(chunk) {
				collected.push(chunk);
			},
			onDataEnd(bytes, exceeded) {
				byteLength = bytes;
				sizeExceeded = exceeded;
				resolve({ chunks: collected, byteLength, sizeExceeded, remainder });
			},
			onDataRemainder(rem) {
				remainder = rem;
			},
		};

		parser.startDataMode(maxBytes, callbacks);
		for (const chunk of chunks) {
			parser.feedDataMode(chunk);
		}
	});
}

function joinChunks(result: DataResult): string {
	return Buffer.concat(result.chunks).toString();
}

// ---- Command mode ----------------------------------------------------------

describe("SMTPParser – command mode", () => {
	test("parses a single CRLF-terminated line", () => {
		const p = new SMTPParser();
		const lines = p.feedCommandMode(Buffer.from("EHLO test.example\r\n"));
		expect(lines).toEqual(["EHLO test.example"]);
	});

	test("parses a single LF-only terminated line", () => {
		const p = new SMTPParser();
		const lines = p.feedCommandMode(Buffer.from("EHLO test.example\n"));
		expect(lines).toEqual(["EHLO test.example"]);
	});

	test("multiple lines in one chunk (pipelining)", () => {
		const p = new SMTPParser();
		const lines = p.feedCommandMode(
			Buffer.from("MAIL FROM:<a@b.com>\r\nRCPT TO:<c@d.com>\r\nDATA\r\n"),
		);
		expect(lines).toEqual(["MAIL FROM:<a@b.com>", "RCPT TO:<c@d.com>", "DATA"]);
	});

	test("line split across two chunks", () => {
		const p = new SMTPParser();
		const first = p.feedCommandMode(Buffer.from("EHLO exam"));
		expect(first).toEqual([]);
		const second = p.feedCommandMode(Buffer.from("ple.com\r\n"));
		expect(second).toEqual(["EHLO example.com"]);
	});

	test("flush() returns partial line when socket closes", () => {
		const p = new SMTPParser();
		p.feedCommandMode(Buffer.from("QUIT")); // no newline
		const flushed = p.flush();
		expect(flushed).toEqual(["QUIT"]);
	});

	test("returns nothing after isClosed = true", () => {
		const p = new SMTPParser();
		p.isClosed = true;
		const lines = p.feedCommandMode(Buffer.from("EHLO x\r\n"));
		expect(lines).toEqual([]);
	});
});

// ---- Data mode – basic -----------------------------------------------------

describe("SMTPParser – data mode basics", () => {
	test("simple message, all in one chunk", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(p, [
			Buffer.from("Subject: hi\r\n\r\nHello world\r\n.\r\n"),
		]);
		expect(joinChunks(result)).toBe("Subject: hi\r\n\r\nHello world\r\n");
		expect(result.byteLength).toBe(28);
		expect(result.sizeExceeded).toBe(false);
	});

	test("empty message (terminator immediately)", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(p, [Buffer.from(".\r\n")]);
		expect(joinChunks(result)).toBe("");
		expect(result.byteLength).toBe(0);
	});

	test("message split across many small chunks", async () => {
		const p = new SMTPParser();
		const full = "Line one\r\nLine two\r\n.\r\n";
		const chunks = full.split("").map((c) => Buffer.from(c));
		const result = await collectDataMode(p, chunks);
		expect(joinChunks(result)).toBe("Line one\r\nLine two\r\n");
	});

	test("terminator split across chunk boundary", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(p, [
			Buffer.from("Hello\r\n"),
			Buffer.from(".\r"),
			Buffer.from("\n"),
		]);
		expect(joinChunks(result)).toBe("Hello\r\n");
	});
});

// ---- Data mode – dot-unstuffing --------------------------------------------

describe("SMTPParser – dot-unstuffing", () => {
	test("dot-stuffed dot in the middle of a message", async () => {
		const p = new SMTPParser();
		// RFC 5321: ".. " at start of line -> "." after unstuffing
		const result = await collectDataMode(p, [
			Buffer.from("Line 1\r\n..dotline\r\n.\r\n"),
		]);
		expect(joinChunks(result)).toBe("Line 1\r\n.dotline\r\n");
	});

	test("dot-stuffed dot split across chunk boundary", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(p, [
			Buffer.from("Line 1\r\n."),
			Buffer.from(".dotline\r\n.\r\n"),
		]);
		expect(joinChunks(result)).toBe("Line 1\r\n.dotline\r\n");
	});

	test("multiple dot-stuffed lines", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(p, [
			Buffer.from("..first\r\n..second\r\n.\r\n"),
		]);
		expect(joinChunks(result)).toBe(".first\r\n.second\r\n");
	});
});

// ---- Data mode – size limit ------------------------------------------------

describe("SMTPParser – size limit", () => {
	test("sizeExceeded false when under limit", async () => {
		const p = new SMTPParser();
		const result = await collectDataMode(
			p,
			[Buffer.from("short\r\n.\r\n")],
			1000,
		);
		expect(result.sizeExceeded).toBe(false);
	});

	test("sizeExceeded true when over limit", async () => {
		const p = new SMTPParser();
		// 7 bytes body, limit = 5
		const result = await collectDataMode(
			p,
			[Buffer.from("1234567\r\n.\r\n")],
			5,
		);
		expect(result.sizeExceeded).toBe(true);
		expect(result.byteLength).toBeGreaterThan(5);
	});
});

// ---- Data mode – pipelined remainder ---------------------------------------

describe("SMTPParser – post-terminator remainder", () => {
	test("bytes after \\r\\n.\\r\\n are returned as remainder", async () => {
		const p = new SMTPParser();
		let remainder: Buffer | null = null;

		await new Promise<void>((resolve) => {
			p.startDataMode(0, {
				onData() {},
				onDataEnd() {
					resolve();
				},
				onDataRemainder(rem) {
					remainder = rem;
				},
			});
			p.feedDataMode(Buffer.from("body\r\n.\r\nRSET\r\n"));
		});

		expect(remainder).not.toBeNull();
		expect((remainder as unknown as Buffer).toString()).toBe("RSET\r\n");
	});
});
