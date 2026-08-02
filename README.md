<div align="center">
  <h1>bun-smtp</h1>
</div>

<hr />

[![Build](https://img.shields.io/github/actions/workflow/status/puiusabin/bun-smtp/ci.yml?branch=main&label=build)](https://github.com/puiusabin/bun-smtp/actions)
[![npm](https://img.shields.io/npm/v/bun-smtp)](https://www.npmjs.com/package/bun-smtp)
[![npm](https://img.shields.io/npm/dm/bun-smtp)](https://www.npmjs.com/package/bun-smtp)
[![GitHub](https://img.shields.io/github/license/puiusabin/bun-smtp)](https://github.com/puiusabin/bun-smtp/blob/main/LICENSE)
[![npm bundle size](https://img.shields.io/npm/unpacked-size/bun-smtp)](https://www.npmjs.com/package/bun-smtp)
[![GitHub commit activity](https://img.shields.io/github/commit-activity/m/puiusabin/bun-smtp)](https://github.com/puiusabin/bun-smtp/pulse)
[![GitHub last commit](https://img.shields.io/github/last-commit/puiusabin/bun-smtp)](https://github.com/puiusabin/bun-smtp/commits/main)

> [!WARNING]
> **STARTTLS requires a Bun canary build.** Bun's server-side `socket.upgradeTLS()` was
> blocked since bun-smtp's inception by [oven-sh/bun#25044](https://github.com/oven-sh/bun/issues/25044)
> (closed 2026-07-24). The fix has landed upstream — the architecture prerequisite in Bun
> 1.3.14 ([oven-sh/bun#29932](https://github.com/oven-sh/bun/pull/29932)) plus the actual
> `isServer` support in [oven-sh/bun#32630](https://github.com/oven-sh/bun/pull/32630) —
> but as of this writing it's only available on Bun canary builds, not yet in any stable
> release (latest stable is 1.3.14). On stable Bun, a STARTTLS attempt closes the
> connection rather than crashing the server. For production on stable Bun, use implicit
> TLS (port 465) or terminate TLS externally with HAProxy or stunnel; to use STARTTLS
> today, install Bun canary (`bun upgrade --canary`).

A fast SMTP/LMTP server library built natively on Bun.

**Up to 3x faster than `smtp-server`** — see [Benchmarks](#benchmarks).

```ts
import { SMTPServer } from "bun-smtp";

const server = new SMTPServer({
  authOptional: true,
  onData(stream, session, callback) {
    async function drain() {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      callback(null);
    }
    drain().catch(callback);
  },
});

await server.listen(2525);
```

## Quick Start

```sh
bun add bun-smtp
```

## Features

- **Ultrafast** ⚡ - Up to 3x faster than `smtp-server` on large payloads, 54% faster on concurrent transactions. See [Benchmarks](#benchmarks).
- **Bun-native** 🚀 - Uses `Bun.listen()` and `Bun.CryptoHasher`. No Node.js compat layer. STARTTLS works via `socket.upgradeTLS()` on Bun canary ([oven-sh/bun#25044](https://github.com/oven-sh/bun/issues/25044) is closed upstream; not yet in a stable release).
- **Drop-in replacement** 🔄 - Same constructor options, callbacks, and event names as `smtp-server`. Minimal migration effort.
- **Full SMTP support** 📨 - HELO, EHLO, MAIL FROM, RCPT TO, DATA, STARTTLS, LMTP, and more.
- **SASL auth** 🔐 - PLAIN, LOGIN, CRAM-MD5, and XOAUTH2 out of the box.

- **TypeScript first** 🟦 - Fully typed API with strong types throughout.

## Benchmarks

vs `smtp-server` on Node, same machine, same client:

| Scenario | bun-smtp | smtp-server | Advantage |
| --- | --- | --- | --- |
| Concurrent transactions (50 connections) | 43,650 msg/s | 28,257 msg/s | **+54.5%** |
| Large payloads (10 connections, 1MB bodies) | 1,669 MB/s | 573 MB/s | **+191.1%** |

Methodology and full results: [`bench/RESULTS.md`](bench/RESULTS.md). Run it yourself: `bun run bench`.

## Documentation

[puiusabin.github.io/bun-smtp](https://puiusabin.github.io/bun-smtp/)

## Contributing

Contributions welcome.

- Open an issue to propose a feature or report a bug.
- Open a pull request to fix a bug or improve docs.

## Authors

Sabin Puiu <https://github.com/puiusabin>

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
