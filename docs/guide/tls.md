# TLS & STARTTLS

## Modes

bun-smtp supports two TLS modes:

- **Implicit TLS** (`secure: true`) — TLS from the first byte. Used on port 465.
- **STARTTLS** (default) — Plain connection upgraded to TLS on demand. Used on ports 25 and 587.

## Implicit TLS

Set `secure: true` and provide a certificate:

```ts
import { readFileSync } from "node:fs";

const server = new SMTPServer({
  secure: true,
  key: readFileSync("server.key"),
  cert: readFileSync("server.crt"),
  onData(stream, session, callback) {
    stream.pipeTo(new WritableStream()).then(() => callback(null), callback);
  },
});

await server.listen(465);
```

## STARTTLS

STARTTLS is advertised by default when `key` and `cert` are set. Clients upgrade by sending `STARTTLS` after the initial handshake.

```ts
const server = new SMTPServer({
  key: readFileSync("server.key"),
  cert: readFileSync("server.crt"),
  onData(stream, session, callback) {
    stream.pipeTo(new WritableStream()).then(() => callback(null), callback);
  },
});

await server.listen(587);
```

To hide STARTTLS from the EHLO capability list (but still support it):

```ts
{ hideSTARTTLS: true }
```

## Requiring STARTTLS before auth

Set `needsUpgrade: true` to force clients to complete STARTTLS before sending AUTH or MAIL:

```ts
const server = new SMTPServer({
  needsUpgrade: true,
  key: readFileSync("server.key"),
  cert: readFileSync("server.crt"),
});
```

Clients that attempt AUTH before upgrading receive a `530 5.7.0 Must issue a STARTTLS command first` error.

## Development (no certificate)

When no `key`/`cert` is provided, bun-smtp uses a built-in self-signed certificate. This lets you run a server in development without any configuration:

```ts
const server = new SMTPServer({ authOptional: true });
await server.listen(2525);
// STARTTLS works immediately — no cert setup required
```

Do not use the built-in cert in production.

## SNI (multiple domains)

Use `sniOptions` to serve different certificates per hostname:

```ts
const server = new SMTPServer({
  sniOptions: {
    "mail.example.com": {
      key: readFileSync("example-com.key"),
      cert: readFileSync("example-com.crt"),
    },
    "mail.other.org": {
      key: readFileSync("other-org.key"),
      cert: readFileSync("other-org.crt"),
    },
  },
});
```

`sniOptions` accepts a plain object or a `Map<string, TLSOptions>`.

## Validating the TLS handshake

Use `onSecure` to inspect or reject connections after TLS is established:

```ts
const server = new SMTPServer({
  requestCert: true,
  onSecure(socket, session, callback) {
    // socket.getPeerCertificate() is available here
    callback(null);
  },
});
```

`onSecure` is called after both implicit TLS and STARTTLS upgrades.

## TLS options

| Option | Type | Description |
|--------|------|-------------|
| `key` | `string \| Buffer` | Private key in PEM format |
| `cert` | `string \| Buffer` | Certificate in PEM format |
| `ca` | `string \| Buffer \| Array` | CA certificates for client verification |
| `requestCert` | `boolean` | Request a client certificate |
| `rejectUnauthorized` | `boolean` | Reject clients with invalid certs |
| `minVersion` | `string` | Minimum TLS version (e.g. `"TLSv1.2"`) |
| `maxVersion` | `string` | Maximum TLS version |
| `sniOptions` | `Record<string, TLSOptions> \| Map<string, TLSOptions>` | Per-hostname TLS config |

## Updating certificates at runtime

Rotate certificates without restarting the server:

```ts
server.updateSecureContext({
  key: readFileSync("new-server.key"),
  cert: readFileSync("new-server.crt"),
});
```
