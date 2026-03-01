# Migrating from smtp-server

bun-smtp mirrors the smtp-server API. Most servers can switch with only an
install change and a single `onData` adjustment. This page covers exactly what
differs.

## Install & import

| | smtp-server | bun-smtp |
|---|---|---|
| Install | `npm install smtp-server` | `bun add bun-smtp` |
| Import | `const { SMTPServer } = require('smtp-server')` | `import { SMTPServer } from 'bun-smtp'` |

## Starting the server

`server.listen()` now returns a `Promise`. The callback style still works, but
you can also await it:

```ts
// smtp-server
server.listen(2525, callback);

// bun-smtp — callback still works
server.listen(2525, callback);

// or await
await server.listen(2525);
```

## onData stream

This is the one change most servers will need. smtp-server passes a Node.js
`Readable`; bun-smtp passes a Web `ReadableStream<Uint8Array>`.

**Before** (smtp-server):

```ts
onData(stream, session, callback) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.on("end", () => {
    const body = Buffer.concat(chunks);
    callback(null);
  });
  stream.on("error", callback);
}
```

**After** (bun-smtp):

```ts
onData(stream, session, callback) {
  async function process() {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    callback(null);
  }
  process().catch(callback);
}
```

To discard the body without reading it:

```ts
onData(stream, session, callback) {
  stream.pipeTo(new WritableStream()).then(() => callback(null), callback);
}
```

`stream.byteLength` and `stream.sizeExceeded` work the same — they are set
after the stream closes.

## logger option

smtp-server accepts a `logger` option (bunyan-compatible). bun-smtp does not.
Remove it from your constructor options. If you need logging, add it directly
in `onConnect` and `onClose`.

## onSecure socket type

The `socket` argument in `onSecure` is a Bun `Socket`, not a Node.js
`tls.TLSSocket`. TLS details (cipher, protocol version) are available on
`session.tlsOptions` instead.

## What stays the same

Everything else is a direct drop-in:

- All constructor options (names, types, defaults)
- Callbacks: `onConnect`, `onAuth`, `onMailFrom`, `onRcptTo`, `onClose`
- `onAuth` auth object shape for PLAIN, LOGIN, CRAM-MD5, and XOAUTH2
- `SMTPSession` fields
- `SMTPAddress` and envelope structure
- `error.responseCode` for custom SMTP error codes
- TLS options: `key`, `cert`, `ca`, `sniOptions`, etc.
- `server.close(callback)`
- `server.updateSecureContext(options)`
- Events: `"listening"`, `"close"`, `"error"`, `"connect"`
