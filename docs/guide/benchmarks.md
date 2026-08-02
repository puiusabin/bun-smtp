# Benchmarks

vs `smtp-server` on Node, same machine, same client:

| Scenario | bun-smtp | smtp-server | Advantage |
| --- | --- | --- | --- |
| Concurrent transactions (50 connections) | 43,650 msg/s | 28,257 msg/s | **+54.5%** |
| Large payloads (10 connections, 1MB bodies) | 1,669 MB/s | 573 MB/s | **+191.1%** |

Full methodology and results: [`bench/RESULTS.md`](https://github.com/puiusabin/bun-smtp/blob/main/bench/RESULTS.md).

## Run it yourself

```sh
git clone https://github.com/puiusabin/bun-smtp
cd bun-smtp
bun install
bun run bench
```
