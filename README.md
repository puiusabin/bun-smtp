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

A fast, lightweight SMTP server library built natively on Bun.

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

- **Bun-native** 🚀 - Uses `Bun.listen()`, `socket.upgradeTLS()`, and `Bun.CryptoHasher`. No Node.js compat layer.
**Drop-in replacement** 🔄 - Same constructor options, callbacks, and event names as `smtp-server`. Minimal migration effort.
- **Full SMTP support** 📨 - HELO, EHLO, MAIL FROM, RCPT TO, DATA, STARTTLS, LMTP, and more.
- **SASL auth** 🔐 - PLAIN, LOGIN, CRAM-MD5, and XOAUTH2 out of the box.

- **TypeScript first** 🟦 - Fully typed API with strong types throughout.

## Documentation

Full docs coming soon.

## Contributing

Contributions welcome.

- Open an issue to propose a feature or report a bug.
- Open a pull request to fix a bug or improve docs.

## Authors

Sabin Puiu <https://github.com/puiusabin>

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
