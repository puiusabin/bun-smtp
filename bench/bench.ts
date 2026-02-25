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
import { SMTPServer as BunSMTPServer } from "../index.ts";

// ---- Spawn Node.js smtp-server ----------------------------------------------

async function spawnNodeServer(port: number): Promise<ReturnType<typeof Bun.spawn>> {
  const script = import.meta.dir + "/node-server.cjs";
  const proc = Bun.spawn(["node", script, String(port)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    if (buf.includes("ready")) break;
  }
  reader.releaseLock();
  return proc;
}

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

// ---- SMTP client — persistent connection worker ----------------------------
//
// Each worker opens one TCP connection, sends `count` emails over it using
// RSET between transactions, then QUITs. This eliminates TCP handshake and
// TIME_WAIT overhead from the measurement.

type State = "banner" | "ehlo" | "mail" | "rcpt" | "data_cmd" | "body" | "rset" | "quit";

function runWorker(
  host: string,
  port: number,
  count: number,
  startIdx: number,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const latencies: number[] = [];
    let msgIdx = startIdx;
    let buf = "";
    let state: State = "banner";
    let dataSentAt = 0;

    function flush() {
      while (true) {
        const nl = buf.indexOf("\r\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (!line) continue;
        if (line[3] === "-") continue; // multi-line continuation

        const code = parseInt(line.slice(0, 3), 10);
        if (code >= 500) { socket.destroy(); reject(new Error(`SMTP ${code}: ${line}`)); return; }

        if (state === "banner") {
          socket.write("EHLO benchmark.test\r\n");
          state = "ehlo";
        } else if (state === "ehlo") {
          socket.write("MAIL FROM:<sender@benchmark.test>\r\n");
          state = "mail";
        } else if (state === "mail") {
          socket.write("RCPT TO:<recipient@benchmark.test>\r\n");
          state = "rcpt";
        } else if (state === "rcpt") {
          socket.write("DATA\r\n");
          state = "data_cmd";
        } else if (state === "data_cmd") {
          const payload = PAYLOADS[msgIdx % PAYLOADS.length] ?? "";
          dataSentAt = performance.now();
          socket.write(`${payload}\r\n`);
          state = "body";
        } else if (state === "body") {
          latencies.push(performance.now() - dataSentAt);
          msgIdx++;
          if (latencies.length >= count) {
            socket.write("QUIT\r\n");
            state = "quit";
            socket.end();
            resolve(latencies);
            return;
          }
          // Reuse connection: RSET clears envelope, keeps session
          socket.write("RSET\r\n");
          state = "rset";
        } else if (state === "rset") {
          socket.write("MAIL FROM:<sender@benchmark.test>\r\n");
          state = "mail";
        }
      }
    }

    socket.on("data", (d) => { buf += d.toString(); flush(); });
    socket.on("error", reject);
    socket.setTimeout(30_000, () => { socket.destroy(); reject(new Error("Socket timeout")); });
  });
}

// ---- Batch runner -----------------------------------------------------------

function runBatch(
  host: string,
  port: number,
  count: number,
  concurrency: number,
): Promise<{ latencies: number[]; errors: number }> {
  const workers: Promise<number[]>[] = [];
  const slots = Math.min(concurrency, count);
  const base = Math.floor(count / slots);
  const extra = count % slots;
  let startIdx = 0;
  for (let i = 0; i < slots; i++) {
    const n = base + (i < extra ? 1 : 0);
    workers.push(runWorker(host, port, n, startIdx));
    startIdx += n;
  }
  return Promise.allSettled(workers).then((results) => {
    const latencies: number[] = [];
    let errors = 0;
    for (const r of results) {
      if (r.status === "fulfilled") latencies.push(...r.value);
      else errors += base + (errors < extra ? 1 : 0);
    }
    return { latencies, errors };
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

  const t0 = performance.now();
  const { latencies, errors } = await runBatch(host, port, TOTAL, CONCURRENCY);
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
  const nodeProc = await spawnNodeServer(PORT_ORIGINAL);

  const bunServer = new BunSMTPServer({
    authOptional: true,
    disableReverseLookup: true,
    onData(stream, _session, cb) {
      const reader = stream.getReader();
      const drain = (): void => {
        reader.read().then(({ done }) => {
          if (done) { reader.releaseLock(); cb(null); } else drain();
        }).catch(cb);
      };
      drain();
    },
  });
  bunServer.listen(PORT_BUN, HOST);

  console.log(`smtp-server (node) → ${HOST}:${PORT_ORIGINAL}`);
  console.log(`bun-smtp           → ${HOST}:${PORT_BUN}`);
  console.log(`concurrency  : ${CONCURRENCY} | total: ${TOTAL} | size: ${SIZE} | warmup: ${WARMUP}`);
  console.log();

  const statsOriginal = await runBenchmark(HOST, PORT_ORIGINAL, "smtp-server");
  const statsBun = await runBenchmark(HOST, PORT_BUN, "bun-smtp");

  printTable(statsOriginal, statsBun);

  nodeProc.kill();
  await new Promise<void>((r) => bunServer.close(r));

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
