import { SMTPClient } from "./client.ts";
import { withTimeout } from "./util.ts";

export interface ScenarioResult {
	name: string;
	metricName: string;
	metricValue: number;
	unit: string;
}

const OP_TIMEOUT_MS = 3000;

/** Wraps text into realistic ~76-char SMTP body lines (no line starts with "."). */
function makeBody(sizeBytes: number): string {
	const lineLen = 76;
	const line = "x".repeat(lineLen);
	const linesNeeded = Math.ceil(sizeBytes / (lineLen + 2));
	return Array.from({ length: linesNeeded }, () => line).join("\r\n");
}

async function connectAndGreet(
	port: number,
	label: string,
): Promise<SMTPClient> {
	const client = new SMTPClient();
	await withTimeout(client.connect(port), OP_TIMEOUT_MS, `${label}: connect`);
	await client.send("EHLO bench.local");
	await withTimeout(
		client.readResponse(),
		OP_TIMEOUT_MS,
		`${label}: EHLO response`,
	);
	return client;
}

/** Sequential connect -> EHLO -> QUIT round trips. Measures accept + greeting overhead. */
export async function connectionThroughput(
	port: number,
	count = 1000,
): Promise<ScenarioResult> {
	const start = performance.now();
	for (let i = 0; i < count; i++) {
		const label = `connectionThroughput #${i}`;
		const client = new SMTPClient();
		await withTimeout(client.connect(port), OP_TIMEOUT_MS, `${label}: connect`); // consumes the 220 greeting
		await client.send("EHLO bench.local");
		await withTimeout(
			client.readResponse(),
			OP_TIMEOUT_MS,
			`${label}: EHLO response`,
		);
		await client.send("QUIT");
		await withTimeout(
			client.readResponse(),
			OP_TIMEOUT_MS,
			`${label}: QUIT response`,
		);
		client.close();
		if ((i + 1) % 200 === 0) {
			console.log(`  connectionThroughput: ${i + 1}/${count}`);
		}
	}
	const elapsedSec = (performance.now() - start) / 1000;
	return {
		name: "Connection throughput",
		metricName: "connections/sec",
		metricValue: count / elapsedSec,
		unit: "conn/s",
	};
}

/**
 * Concurrent persistent connections, each pipelining MAIL/RCPT/DATA with a
 * small body in a loop for a fixed window. Measures parser + state machine
 * overhead under concurrency.
 */
export async function concurrentTransactionThroughput(
	port: number,
	concurrency = 50,
	durationMs = 5000,
): Promise<ScenarioResult> {
	const body = makeBody(200);

	const clients = await Promise.all(
		Array.from({ length: concurrency }, (_, i) =>
			connectAndGreet(port, `concurrentTransactionThroughput setup #${i}`),
		),
	);
	console.log(
		`  concurrentTransactionThroughput: ${concurrency} connections ready`,
	);

	const start = performance.now();
	const deadline = start + durationMs;
	let totalMessages = 0;

	await Promise.all(
		clients.map(async (client, workerIdx) => {
			while (performance.now() < deadline) {
				const label = `concurrentTransactionThroughput worker #${workerIdx}`;
				await client.send("MAIL FROM:<bench@example.com>");
				await withTimeout(
					client.readResponse(),
					OP_TIMEOUT_MS,
					`${label}: MAIL response`,
				);
				await client.send("RCPT TO:<rcpt@example.com>");
				await withTimeout(
					client.readResponse(),
					OP_TIMEOUT_MS,
					`${label}: RCPT response`,
				);
				await client.send("DATA");
				await withTimeout(
					client.readResponse(),
					OP_TIMEOUT_MS,
					`${label}: DATA response`,
				);
				await client.sendRaw(`${body}\r\n.\r\n`);
				await withTimeout(
					client.readResponse(),
					OP_TIMEOUT_MS,
					`${label}: post-DATA response`,
				);
				totalMessages++;
			}
			client.close();
		}),
	);

	const elapsedSec = (performance.now() - start) / 1000;
	return {
		name: "Concurrent transaction throughput",
		metricName: "messages/sec",
		metricValue: totalMessages / elapsedSec,
		unit: "msg/s",
	};
}

/**
 * Concurrent connections streaming a large (~1MB) DATA body in a loop for a
 * fixed window. Measures sustained DATA-mode byte throughput.
 */
export async function largePayloadThroughput(
	port: number,
	concurrency = 10,
	durationMs = 5000,
	payloadBytes = 1024 * 1024,
): Promise<ScenarioResult> {
	const body = makeBody(payloadBytes);
	const opTimeoutMs = Math.max(OP_TIMEOUT_MS, 10_000); // large body needs more headroom

	const clients = await Promise.all(
		Array.from({ length: concurrency }, (_, i) =>
			connectAndGreet(port, `largePayloadThroughput setup #${i}`),
		),
	);
	console.log(`  largePayloadThroughput: ${concurrency} connections ready`);

	const start = performance.now();
	const deadline = start + durationMs;
	let totalBytes = 0;

	await Promise.all(
		clients.map(async (client, workerIdx) => {
			while (performance.now() < deadline) {
				const label = `largePayloadThroughput worker #${workerIdx}`;
				await client.send("MAIL FROM:<bench@example.com>");
				await withTimeout(
					client.readResponse(),
					opTimeoutMs,
					`${label}: MAIL response`,
				);
				await client.send("RCPT TO:<rcpt@example.com>");
				await withTimeout(
					client.readResponse(),
					opTimeoutMs,
					`${label}: RCPT response`,
				);
				await client.send("DATA");
				await withTimeout(
					client.readResponse(),
					opTimeoutMs,
					`${label}: DATA response`,
				);
				await client.sendRaw(`${body}\r\n.\r\n`);
				await withTimeout(
					client.readResponse(),
					opTimeoutMs,
					`${label}: post-DATA response`,
				);
				totalBytes += body.length;
			}
			client.close();
		}),
	);

	const elapsedSec = (performance.now() - start) / 1000;
	return {
		name: "Large payload throughput",
		metricName: "MB/sec",
		metricValue: totalBytes / (1024 * 1024) / elapsedSec,
		unit: "MB/s",
	};
}

export const SCENARIOS = [
	connectionThroughput,
	concurrentTransactionThroughput,
	largePayloadThroughput,
] as const;
