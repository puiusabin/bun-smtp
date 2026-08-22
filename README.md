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

An ultrafast SMTP/LMTP server library built natively on Bun.

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
- **Bun-native** 🚀 - Uses `Bun.listen()`, `socket.upgradeTLS()`, and `Bun.CryptoHasher`. No Node.js compat layer.
- **Drop-in replacement** 🔄 - Same constructor options, callbacks, and event names as `smtp-server`. Minimal migration effort.

- **Delightful DX** ✨ - Fully typed API, sensible defaults, and minimal boilerplate.

## Benchmarks

| Scenario                                    | bun-smtp     | smtp-server  | Advantage   |
| ------------------------------------------- | ------------ | ------------ | ----------- |
| Concurrent transactions (50 connections)    | 43,650 msg/s | 28,257 msg/s | **+54.5%**  |
| Large payloads (10 connections, 1MB bodies) | 1,669 MB/s   | 573 MB/s     | **+191.1%** |

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
