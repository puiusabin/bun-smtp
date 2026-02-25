/**
 * Head-to-head throughput / latency benchmark.
 *
 * Starts both smtp-server (original Node.js) and bun-smtp side-by-side on
 * different ports, runs an SMTP load client against each, then prints a
 * comparison table.
 *
 *   bun bench/bench.ts [--concurrency N] [--total N] [--size 1k|10k]
 *                      [--warmup N] [--port-original N] [--port-bun N]
 */

import net from "node:net";
import { createRequire } from "node:module";
import { SMTPServer as BunSMTPServer } from "../index.ts";

// ---- CLI args ----------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? (process.argv[idx + 1] ?? fallback) : fallback;
}

const HOST = "127.0.0.1";
const PORT_ORIGINAL = parseInt(arg("port-original", "2525"), 10);
const PORT_BUN = parseInt(arg("port-bun", "2526"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "50"), 10);
const TOTAL = parseInt(arg("total", "1000"), 10);
const SIZE = arg("size", "1k");
const WARMUP = parseInt(arg("warmup", "50"), 10);

// ---- Message payloads -------------------------------------------------------

const SUBJECTS = [
  "Meeting tomorrow",
  "Invoice #1234",
  "Re: Project update",
  "Weekly report",
  "Action required",
];

function makeBody(size: string, subject: string): string {
  const targetBytes = size === "10k" ? 10_000 : 1_000;
  const headers =
    "Date: Mon, 01 Jan 2024 00:00:00 +0000\r\n" +
    "From: sender@benchmark.test\r\n" +
    "To: recipient@benchmark.test\r\n" +
    `Subject: ${subject}\r\n` +
    "\r\n";
  const padLen = Math.max(0, targetBytes - headers.length - 3);
  return headers + "x".repeat(padLen);
}

const PAYLOADS: string[] = SUBJECTS.map((sub) => `${makeBody(SIZE, sub)}\r\n.`);

// ---- SMTP client state machine ----------------------------------------------

type State = "banner" | "ehlo" | "mail" | "rcpt" | "data_cmd" | "body" | "quit";

function sendOne(host: string, port: number, payloadIdx: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const DATA_PAYLOAD = PAYLOADS[payloadIdx % PAYLOADS.length] ?? "";
    let buf = "";
    let state: State = "banner";
    let dataSentAt = 0;

    function flush() {
      while (true) {
        const idx = buf.indexOf("\r\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        if (line[3] === "-") continue; // multi-line continuation

        const code = parseInt(line.slice(0, 3), 10);

        if (code >= 500) {
          socket.destroy();
          reject(new Error(`SMTP ${code} in state ${state}: ${line}`));
          return;
        }

        if (state === "banner") {
          if (code !== 220) { socket.destroy(); reject(new Error(`Expected 220, got ${code}`)); return; }
          socket.write("EHLO benchmark.test\r\n");
          state = "ehlo";
        } else if (state === "ehlo") {
          if (code !== 250) { socket.destroy(); reject(new Error(`Expected 250 after EHLO, got ${code}`)); return; }
          socket.write("MAIL FROM:<sender@benchmark.test>\r\n");
          state = "mail";
        } else if (state === "mail") {
          if (code !== 250) { socket.destroy(); reject(new Error(`Expected 250 after MAIL FROM, got ${code}`)); return; }
          socket.write("RCPT TO:<recipient@benchmark.test>\r\n");
          state = "rcpt";
        } else if (state === "rcpt") {
          if (code !== 250) { socket.destroy(); reject(new Error(`Expected 250 after RCPT TO, got ${code}`)); return; }
          socket.write("DATA\r\n");
          state = "data_cmd";
        } else if (state === "data_cmd") {
          if (code !== 354) { socket.destroy(); reject(new Error(`Expected 354 after DATA, got ${code}`)); return; }
          dataSentAt = performance.now();
          socket.write(`${DATA_PAYLOAD}\r\n`);
          state = "body";
        } else if (state === "body") {
          if (code !== 250) { socket.destroy(); reject(new Error(`Expected 250 after body, got ${code}`)); return; }
          const latency = performance.now() - dataSentAt;
          socket.write("QUIT\r\n");
          state = "quit";
          socket.end();
          resolve(latency);
          return;
        }
      }
    }

    socket.on("data", (d) => { buf += d.toString(); flush(); });
    socket.on("error", reject);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("Socket timeout")); });
  });
}

// ---- Batch runner -----------------------------------------------------------

function runBatch(
  host: string,
  port: number,
  count: number,
  concurrency: number
): Promise<number[]> {
  return new Promise((resolve) => {
    const latencies: number[] = [];
    let errors = 0;
    let completed = 0;
    let started = 0;

    function next() {
      if (started >= count && completed >= started) { resolve(latencies); return; }
      if (started >= count) return;

      const msgIdx = started++;

      sendOne(host, port, msgIdx)
        .then((lat) => {
          latencies.push(lat);
          completed++;
          next();
          if (completed >= count) resolve(latencies);
        })
        .catch(() => {
          errors++;
          completed++;
          next();
          if (completed >= count) resolve(latencies);
        });
    }

    for (let i = 0; i < Math.min(concurrency, count); i++) next();
  });
}

// ---- Stats ------------------------------------------------------------------

interface Stats {
  label: string;
  throughput: number;
  totalMs: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  total: number;
}

function computeStats(
  label: string,
  latencies: number[],
  totalMs: number,
  errors: number,
  total: number
): Stats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (pct: number) => {
    if (sorted.length === 0) return 0;
    const idx = Math.floor((pct / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
  };
  return {
    label,
    throughput: total / (totalMs / 1000),
    totalMs,
    p50: p(50),
    p95: p(95),
    p99: p(99),
    errors,
    total,
  };
}

// ---- Benchmark runner -------------------------------------------------------

async function runBenchmark(
  host: string,
  port: number,
  label: string
): Promise<Stats> {
  process.stdout.write(`  [${label}] warming up (${WARMUP} msgs)... `);
  await runBatch(host, port, WARMUP, CONCURRENCY);
  console.log("done");

  process.stdout.write(`  [${label}] measuring  (${TOTAL} msgs)... `);
  let errors = 0;

  const t0 = performance.now();
  const latencies = await new Promise<number[]>((resolve) => {
    const all: number[] = [];
    let completed = 0;
    let started = 0;

    function next() {
      if (started >= TOTAL && completed >= started) { resolve(all); return; }
      if (started >= TOTAL) return;

      const msgIdx = started++;

      sendOne(host, port, msgIdx)
        .then((lat) => {
          all.push(lat);
          completed++;
          next();
          if (completed >= TOTAL) resolve(all);
        })
        .catch(() => {
          errors++;
          completed++;
          next();
          if (completed >= TOTAL) resolve(all);
        });
    }

    for (let i = 0; i < Math.min(CONCURRENCY, TOTAL); i++) next();
  });
  const totalMs = performance.now() - t0;

  console.log("done");
  return computeStats(label, latencies, totalMs, errors, TOTAL);
}

// ---- Table printer ----------------------------------------------------------

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function printTable(a: Stats, b: Stats): void {
  const COL = 16;
  const pad = (s: string, w = COL) => s.padEnd(w);
  const rpad = (s: string, w = COL) => s.padStart(w);

  const row = (label: string, va: string, vb: string) =>
    `│ ${pad(label, 15)} │ ${rpad(va, 12)} │ ${rpad(vb, 12)} │`;

  const div = `├─────────────────┼──────────────┼──────────────┤`;
  const top = `┌─────────────────┬──────────────┬──────────────┐`;
  const bot = `└─────────────────┴──────────────┴──────────────┘`;
  const hdr = `│ ${"metric".padEnd(15)} │ ${a.label.padStart(12)} │ ${b.label.padStart(12)} │`;

  console.log();
  console.log(top);
  console.log(hdr);
  console.log(div);
  console.log(row("throughput", `${fmt(a.throughput, 0)} msg/s`, `${fmt(b.throughput, 0)} msg/s`));
  console.log(row("total time", `${fmt(a.totalMs / 1000, 2)}s`, `${fmt(b.totalMs / 1000, 2)}s`));
  console.log(row("p50 latency", `${fmt(a.p50)}ms`, `${fmt(b.p50)}ms`));
  console.log(row("p95 latency", `${fmt(a.p95)}ms`, `${fmt(b.p95)}ms`));
  console.log(row("p99 latency", `${fmt(a.p99)}ms`, `${fmt(b.p99)}ms`));
  console.log(row("errors", `${a.errors}/${a.total}`, `${b.errors}/${b.total}`));
  console.log(bot);

  const ratio = b.throughput / a.throughput;
  if (ratio >= 1.01) {
    console.log(`\nbun-smtp is ${fmt(ratio, 2)}x faster`);
  } else if (ratio <= 0.99) {
    console.log(`\nsmtp-server is ${fmt(1 / ratio, 2)}x faster`);
  } else {
    console.log("\nPerformance is roughly equal");
  }

  if (a.errors > 0) console.log(`⚠  smtp-server had ${a.errors} errors`);
  if (b.errors > 0) console.log(`⚠  bun-smtp had ${b.errors} errors`);
}

// ---- Main -------------------------------------------------------------------

async function main() {
  // Start original smtp-server (CommonJS)
  const _require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { SMTPServer: NodeSMTPServer } = _require("smtp-server") as any;

  const originalServer = new NodeSMTPServer({
    authOptional: true,
    disableReverseLookup: true,
    onData(stream: NodeJS.ReadableStream, _session: unknown, cb: (err: null) => void) {
      stream.on("data", () => {});
      stream.on("end", () => cb(null));
    },
  });

  const bunServer = new BunSMTPServer({
    authOptional: true,
    disableReverseLookup: true,
    async onData(stream, _session, cb) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) { /* drain */ }
      cb(null);
    },
  });

  await new Promise<void>((resolve) => originalServer.listen(PORT_ORIGINAL, HOST, resolve));
  bunServer.listen(PORT_BUN, HOST);

  console.log(`smtp-server  → ${HOST}:${PORT_ORIGINAL}`);
  console.log(`bun-smtp     → ${HOST}:${PORT_BUN}`);
  console.log(`concurrency  : ${CONCURRENCY} | total: ${TOTAL} | size: ${SIZE} | warmup: ${WARMUP}`);
  console.log();

  const statsOriginal = await runBenchmark(HOST, PORT_ORIGINAL, "smtp-server");
  const statsBun = await runBenchmark(HOST, PORT_BUN, "bun-smtp");

  printTable(statsOriginal, statsBun);

  await Promise.all([
    new Promise<void>((r) => originalServer.close(r)),
    new Promise<void>((r) => bunServer.close(r)),
  ]);

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
