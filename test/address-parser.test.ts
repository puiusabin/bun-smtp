import { describe, expect, test } from "bun:test";
import { parseAddressCommand } from "../src/address-parser.ts";

describe("parseAddressCommand – MAIL FROM", () => {
	test("basic address", () => {
		const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<user@example.com>");
		expect(r).toMatchObject({ address: "user@example.com", args: false });
	});

	test("case-insensitive prefix", () => {
		const r = parseAddressCommand("MAIL FROM", "mail from:<user@example.com>");
		expect(r).toMatchObject({ address: "user@example.com" });
	});

	test("with SIZE parameter", () => {
		const r = parseAddressCommand(
			"MAIL FROM",
			"MAIL FROM:<a@b.com> SIZE=12345",
		);
		expect(r).not.toBe(false);
		if (r) expect((r.args as Record<string, unknown>).SIZE).toBe("12345");
	});

	test("with BODY=8BITMIME parameter", () => {
		const r = parseAddressCommand(
			"MAIL FROM",
			"MAIL FROM:<a@b.com> BODY=8BITMIME",
		);
		expect(r).not.toBe(false);
		if (r) expect((r.args as Record<string, unknown>).BODY).toBe("8BITMIME");
	});

	test("with SMTPUTF8 flag (no value)", () => {
		const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<a@b.com> SMTPUTF8");
		expect(r).not.toBe(false);
		if (r) expect((r.args as Record<string, unknown>).SMTPUTF8).toBe(true);
	});

	test("empty bounce address <>", () => {
		const r = parseAddressCommand("MAIL FROM", "MAIL FROM:<>");
		expect(r).not.toBe(false);
		if (r) expect(r.address).toBe("");
	});

	test("multiple parameters", () => {
		const r = parseAddressCommand(
			"MAIL FROM",
			"MAIL FROM:<a@b.com> SIZE=100 BODY=7BIT",
		);
		expect(r).not.toBe(false);
		if (r?.args) {
			const args = r.args as Record<string, unknown>;
			expect(args.SIZE).toBe("100");
			expect(args.BODY).toBe("7BIT");
		}
	});

	test("xtext-encoded parameter value", () => {
		// +2B is '+' in xtext
		const r = parseAddressCommand(
			"MAIL FROM",
			"MAIL FROM:<a@b.com> ENVID=foo+2Bbar",
		);
		expect(r).not.toBe(false);
		if (r?.args) {
			expect((r.args as Record<string, unknown>).ENVID).toBe("foo+bar");
		}
	});
});

describe("parseAddressCommand – RCPT TO", () => {
	test("basic address", () => {
		const r = parseAddressCommand("RCPT TO", "RCPT TO:<recipient@example.com>");
		expect(r).toMatchObject({ address: "recipient@example.com" });
	});

	test("with NOTIFY parameter", () => {
		const r = parseAddressCommand(
			"RCPT TO",
			"RCPT TO:<a@b.com> NOTIFY=SUCCESS,FAILURE",
		);
		expect(r).not.toBe(false);
		if (r && r.args) {
			expect((r.args as Record<string, unknown>).NOTIFY).toBe(
				"SUCCESS,FAILURE",
			);
		}
	});

	test("with ORCPT parameter", () => {
		const r = parseAddressCommand(
			"RCPT TO",
			"RCPT TO:<a@b.com> ORCPT=rfc822;original@example.com",
		);
		expect(r).not.toBe(false);
		if (r && r.args) {
			expect((r.args as Record<string, unknown>).ORCPT).toBe(
				"rfc822;original@example.com",
			);
		}
	});
});

describe("parseAddressCommand – invalid inputs", () => {
	test("wrong prefix returns false", () => {
		expect(parseAddressCommand("MAIL FROM", "RCPT TO:<a@b.com>")).toBe(false);
	});

	test("missing colon returns false", () => {
		expect(parseAddressCommand("MAIL FROM", "MAIL FROM <a@b.com>")).toBe(false);
	});

	test("missing angle brackets returns false", () => {
		expect(parseAddressCommand("MAIL FROM", "MAIL FROM:user@example.com")).toBe(
			false,
		);
	});

	test("address without @ returns false", () => {
		expect(parseAddressCommand("MAIL FROM", "MAIL FROM:<nodomain>")).toBe(
			false,
		);
	});

	test("address with leading dot in local part returns false", () => {
		expect(
			parseAddressCommand("MAIL FROM", "MAIL FROM:<.user@example.com>"),
		).toBe(false);
	});

	test("address with trailing dot in local part returns false", () => {
		expect(
			parseAddressCommand("MAIL FROM", "MAIL FROM:<user.@example.com>"),
		).toBe(false);
	});

	test("address with consecutive dots returns false", () => {
		expect(
			parseAddressCommand("MAIL FROM", "MAIL FROM:<u..r@example.com>"),
		).toBe(false);
	});

	test("address exceeding 253 chars returns false", () => {
		const longLocal = "a".repeat(240);
		expect(
			parseAddressCommand("MAIL FROM", `MAIL FROM:<${longLocal}@b.com>`),
		).toBe(false);
	});

	test("empty input returns false", () => {
		expect(parseAddressCommand("MAIL FROM", "")).toBe(false);
	});
});
