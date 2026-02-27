# bun-smtp

A drop-in replacement for the [smtp-server](https://www.npmjs.com/package/smtp-server) npm package, rewritten to run on Bun.

The public API is identical: same constructor options, same callbacks, same event names. The main difference is that the DATA stream is a `ReadableStream<Uint8Array>` instead of a Node.js stream, and it requires Bun >= 1.2.0.

## Installation

```bash
bun add bun-smtp
```

TypeScript users also need `@types/bun`:

```bash
bun add -d @types/bun
```

## Quick start

```typescript
import { SMTPServer } from "bun-smtp";

const server = new SMTPServer({
  authOptional: true,
  onData(stream, session, callback) {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();

    async function read() {
      const { done, value } = await reader.read();
      if (done) {
        const message = Buffer.concat(chunks).toString();
        console.log("Received message:", stream.byteLength, "bytes");
        callback(null);
      } else {
        chunks.push(value);
        read();
      }
    }

    read();
  },
});

server.listen(2525, "0.0.0.0", () => {
  console.log("Listening on port 2525");
});
```

You can also consume the DATA stream with `for await`:

```typescript
onData(stream, session, callback) {
  async function drain() {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const message = Buffer.concat(chunks).toString();
    callback(null);
  }
  drain().catch(callback);
}
```

## Differences from smtp-server

**Runtime.** `bun-smtp` requires Bun >= 1.2.0. It will not run on Node.js. The internals use `Bun.listen()` for TCP, `socket.upgradeTLS()` for STARTTLS, and `Bun.CryptoHasher` for CRAM-MD5.

**DATA stream type.** The original `smtp-server` passes a Node.js `PassThrough` stream to `onData`. `bun-smtp` passes a `ReadableStream<Uint8Array>`. The stream also has two extra properties set after it closes:

- `stream.byteLength` - total bytes received (set after the stream ends)
- `stream.sizeExceeded` - `true` if the message exceeded the `size` limit

Any code that calls `.pipe()`, `.on("data", ...)`, or other Node.js stream methods will need to be updated to use the Web Streams API.

**TypeScript peer dependency.** Add `@types/bun` to your devDependencies. The `Socket` type in callback signatures comes from there.

Everything else, including all constructor options, callback signatures, event names, and SMTP behavior, matches the original package.

## Supported features

- HELO, EHLO, MAIL FROM, RCPT TO, DATA, NOOP, RSET, QUIT, STARTTLS
- LMTP mode (`lmtp: true`)
- SASL auth: PLAIN, LOGIN, CRAM-MD5, XOAUTH2
- TLS (immediate TLS on connect via `secure: true`, or STARTTLS upgrade via `needsUpgrade: true`)
- XCLIENT / XFORWARD proxy headers
- DSN envelope parameters
- Per-connection limits: `maxClients`, `socketTimeout`, `size`, `maxAllowedUnauthenticatedCommands`

## API reference

The full API is documented in the [smtp-server README](https://github.com/nodemailer/smtp-server#readme). All options and callbacks described there work the same way in `bun-smtp`, with the DATA stream exception noted above.

## Requirements

- Bun >= 1.2.0

## License

MIT
