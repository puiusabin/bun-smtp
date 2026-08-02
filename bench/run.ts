/**
 * Orchestrates the bun-smtp vs smtp-server benchmark:
 * spawns each server as a separate OS process, waits for it to report
 * ready, drives it through the shared scenarios, then reports results.
 *
 * Usage: bun bench/run.ts
 */
import { cpus } from "node:os";
import { SCENARIOS, type ScenarioResult } from "./scenarios.ts";

const WARMUP_RUNS = 1;
const TIMED_RUNS = 3;
const READY_TIMEOUT_MS = 5000;

const BUN_TARGET = {
	name: "bun-smtp (Bun)",
	cmd: ["bun", "bench/servers/bun-server.ts"],
};
const NODE_TARGET = {
	name: "smtp-server (Node)",
	cmd: ["node", "bench/servers/node-server.mjs"],
};

function median(nums: number[]): number {
	const sorted = [...nums].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const lo = sorted[mid - 1];
	const hi = sorted[mid];
	if (sorted.length % 2 !== 0) return hi ?? 0;
	return ((lo ?? 0) + (hi ?? 0)) / 2;
}

function randomPort(): number {
	return 20000 + Math.floor(Math.random() * 20000);
}

async function waitForReady(
	proc: ReturnType<typeof Bun.spawn>,
	timeoutMs: number,
): Promise<void> {
	const stdout = proc.stdout;
	if (!(stdout instanceof ReadableStream)) {
		throw new Error("expected piped stdout");
	}
	const reader = stdout.getReader();
	const decoder = new TextDecoder();

	const readyPromise = (async () => {
		let buf = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error("server exited before reporting READY");
			buf += decoder.decode(value);
			if (buf.includes("READY")) return;
		}
	})();
	readyPromise.catch(() => {});

	const timeout = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error("timed out waiting for READY")),
			timeoutMs,
		);
	});

	try {
		await Promise.race([readyPromise, timeout]);
	} finally {
		reader.releaseLock();
	}
}

async function runScenariosAgainst(
	port: number,
): Promise<Map<string, ScenarioResult>> {
	const results = new Map<string, ScenarioResult>();
	for (const scenario of SCENARIOS) {
		console.log(` scenario: ${scenario.name}`);
		for (let i = 0; i < WARMUP_RUNS; i++) {
			console.log(`  warmup run ${i + 1}/${WARMUP_RUNS}`);
			await scenario(port);
		}
		const runs: ScenarioResult[] = [];
		for (let i = 0; i < TIMED_RUNS; i++) {
			console.log(`  timed run ${i + 1}/${TIMED_RUNS}`);
			runs.push(await scenario(port));
		}
		const first = runs[0];
		if (!first) continue;
		results.set(first.name, {
			...first,
			metricValue: median(runs.map((r) => r.metricValue)),
		});
	}
	return results;
}

async function runTarget(target: {
	name: string;
	cmd: string[];
}): Promise<Map<string, ScenarioResult>> {
	const port = randomPort();
	const proc = Bun.spawn([...target.cmd, String(port)], {
		stdout: "pipe",
		stderr: "inherit",
		stdin: "ignore",
	});
	try {
		await waitForReady(proc, READY_TIMEOUT_MS);
		return await runScenariosAgainst(port);
	} finally {
		proc.kill();
		await proc.exited;
	}
}

function formatMetric(r: ScenarioResult): string {
	return `${r.metricValue.toFixed(2)} ${r.unit}`;
}

async function main() {
	const nodeVersion = process.versions?.node ?? "unknown";
	const cpuModel = cpus()[0]?.model ?? "unknown CPU";
	console.log(
		`Bun ${Bun.version} / Node ${nodeVersion} / ${cpuModel} (${cpus().length} cores)\n`,
	);

	console.log(`Running scenarios against ${BUN_TARGET.name}...`);
	const bunResults = await runTarget(BUN_TARGET);

	console.log(`Running scenarios against ${NODE_TARGET.name}...`);
	const nodeResults = await runTarget(NODE_TARGET);

	const lines: string[] = [];
	lines.push("# Benchmark Results");
	lines.push("");
	lines.push(`Generated ${new Date().toISOString()}`);
	lines.push(
		`Bun ${Bun.version}, Node ${nodeVersion}, ${cpuModel} (${cpus().length} cores)`,
	);
	lines.push("");
	lines.push(
		`Methodology: ${WARMUP_RUNS} discarded warmup run + ${TIMED_RUNS} timed runs per scenario, median reported. ` +
			"Both servers run as separate OS processes with identical options " +
			"(`authOptional: true`, `disableReverseLookup: true`) and a no-op `onData` handler " +
			"that only drains the stream. Same client driver (`bench/client.ts`) used against both.",
	);
	lines.push("");
	lines.push(
		`| Scenario | ${BUN_TARGET.name} | ${NODE_TARGET.name} | bun-smtp advantage |`,
	);
	lines.push("| --- | --- | --- | --- |");

	for (const [scenarioName, bunResult] of bunResults) {
		const nodeResult = nodeResults.get(scenarioName);
		if (!nodeResult) continue;
		const pctDiff =
			((bunResult.metricValue - nodeResult.metricValue) /
				nodeResult.metricValue) *
			100;
		const advantage =
			pctDiff >= 0 ? `+${pctDiff.toFixed(1)}%` : `${pctDiff.toFixed(1)}%`;
		const marker = scenarioName === "Connection throughput" ? "\\*" : "";
		lines.push(
			`| ${scenarioName}${marker} | ${formatMetric(bunResult)} | ${formatMetric(nodeResult)} | ${advantage} |`,
		);
	}

	lines.push("");
	lines.push(
		"\\* Both bun-smtp and smtp-server deliberately delay the 220 greeting by 100ms " +
			'before accepting any commands, an anti-spam "early talker" guard present in ' +
			"both implementations (see `smtp-server`'s `smtp-connection.js`, `readyTimer`). " +
			"That fixed per-connection delay dominates this scenario, so it mostly measures " +
			"protocol-parity rather than accept-loop throughput — expect it to land near " +
			"parity regardless of runtime.",
	);

	const output = `${lines.join("\n")}\n`;
	console.log(`\n${output}`);
	await Bun.write("bench/RESULTS.md", output);
	console.log("Results written to bench/RESULTS.md");
}

await main();
