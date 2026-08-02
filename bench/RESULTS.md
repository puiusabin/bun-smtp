# Benchmark Results

Generated 2026-08-02T13:56:11.265Z
Bun 1.3.14, Node 24.3.0, Apple M3 Pro (11 cores)

Methodology: 1 discarded warmup run + 3 timed runs per scenario, median reported. Both servers run as separate OS processes with identical options (`authOptional: true`, `disableReverseLookup: true`) and a no-op `onData` handler that only drains the stream. Same client driver (`bench/client.ts`) used against both.

| Scenario | bun-smtp (Bun) | smtp-server (Node) | bun-smtp advantage |
| --- | --- | --- | --- |
| Connection throughput\* | 9.67 conn/s | 9.66 conn/s | +0.1% |
| Concurrent transaction throughput | 43650.80 msg/s | 28257.11 msg/s | +54.5% |
| Large payload throughput | 1669.02 MB/s | 573.36 MB/s | +191.1% |

\* Both bun-smtp and smtp-server deliberately delay the 220 greeting by 100ms
before accepting any commands, an anti-spam "early talker" guard present in
both implementations (see `smtp-server`'s `smtp-connection.js`, `readyTimer`).
That fixed per-connection delay dominates this scenario, so it mostly measures
protocol-parity rather than accept-loop throughput — expect it to land near
parity regardless of runtime.
