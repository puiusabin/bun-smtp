# Benchmarks

bun-smtp is measured directly against the `smtp-server` npm package it replaces —
same options, same client, both run as separate OS processes (Bun vs Node).

| Scenario | bun-smtp (Bun) | smtp-server (Node) | bun-smtp advantage |
| --- | --- | --- | --- |
| Concurrent transaction throughput (50 connections, MAIL/RCPT/DATA) | 43,650 msg/s | 28,257 msg/s | **+54.5%** |
| Large payload throughput (10 connections, 1MB bodies) | 1,669 MB/s | 573 MB/s | **+191.1%** |

Measured on an Apple M3 Pro. Full methodology, machine details, and the
connection-throughput scenario (which ties — both implementations share the
same 100ms anti-spam "early talker" greeting delay by design) are in
[`bench/RESULTS.md`](https://github.com/puiusabin/bun-smtp/blob/main/bench/RESULTS.md).

## Methodology

The benchmark lives in [`bench/`](https://github.com/puiusabin/bun-smtp/tree/main/bench)
in the repository:

- Both servers run as separate OS processes with identical options
  (`authOptional: true`, `disableReverseLookup: true`) and a no-op `onData`
  handler that only drains the stream.
- The same raw-TCP client drives both targets, so neither side benefits from a
  faster client implementation.
- Each scenario runs one discarded warmup pass, then 3 timed runs; the median
  is reported.

## Run it yourself

```sh
git clone https://github.com/puiusabin/bun-smtp
cd bun-smtp
bun install
bun run bench
```

Results are written to `bench/RESULTS.md` on every run.
