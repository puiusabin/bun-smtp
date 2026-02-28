# Configuration

Pass options to the `SMTPServer` constructor:

```ts
import { SMTPServer } from "bun-smtp";

const server = new SMTPServer({
  // options here
});
```

---

## Connection

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `secure` | `boolean` | `false` | Start in implicit TLS mode (port 465 style). When `false`, STARTTLS is offered instead. |
| `needsUpgrade` | `boolean` | `false` | Reject AUTH and MAIL until the client completes STARTTLS. |
| `name` | `string` | system hostname | Server hostname included in the `220` greeting and EHLO response. |
| `banner` | `string` | `""` | Extra text appended to the `220` greeting line. |
| `lmtp` | `boolean` | `false` | Use LMTP instead of SMTP. Clients open with `LHLO` and `onData` may return per-recipient responses. |
| `heloResponse` | `string` | `"%s Nice to meet you, %s"` | Format string for the HELO/EHLO response. First `%s` is the server name, second is the client hostname. |

---

## Authentication

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `authMethods` | `string[]` | `["PLAIN", "LOGIN"]` | SASL methods advertised in EHLO. Supported values: `"PLAIN"`, `"LOGIN"`, `"CRAM-MD5"`, `"XOAUTH2"`. |
| `authOptional` | `boolean` | `false` | Allow clients to skip AUTH entirely. |
| `allowInsecureAuth` | `boolean` | `false` | Allow AUTH over a plain (non-TLS) connection. |
| `authRequiredMessage` | `string` | — | Custom error message for the `530` response when auth is required. |

---

## Capability flags

These options hide extensions from the EHLO response. The extension still works — it is just not advertised.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hideSTARTTLS` | `boolean` | `false` | Hide `STARTTLS` from EHLO. |
| `hideSize` | `boolean` | `false` | Hide the `SIZE` extension. |
| `hidePIPELINING` | `boolean` | `false` | Hide `PIPELINING`. |
| `hideDSN` | `boolean` | `false` | Hide `DSN` (Delivery Status Notification). |
| `hideENHANCEDSTATUSCODES` | `boolean` | `false` | Hide `ENHANCEDSTATUSCODES`. |
| `hideREQUIRETLS` | `boolean` | `false` | Hide `REQUIRETLS`. |
| `hide8BITMIME` | `boolean` | `false` | Hide `8BITMIME`. |
| `hideSMTPUTF8` | `boolean` | `false` | Hide `SMTPUTF8`. |
| `disabledCommands` | `string[]` | `[]` | Block specific SMTP commands entirely (e.g. `["AUTH", "STARTTLS"]`). |

---

## Limits

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `size` | `number` | — | Maximum message size in bytes. Advertised via the `SIZE` extension. The `onData` stream's `sizeExceeded` flag is set when the limit is hit. |
| `maxClients` | `number` | — | Maximum number of simultaneous connections. New connections are rejected with `421` when the limit is reached. |
| `socketTimeout` | `number` | `60000` | Milliseconds of inactivity before an idle connection is closed. |
| `closeTimeout` | `number` | `30000` | Milliseconds to wait for connections to drain during `server.close()`. Connections still open after this are forcibly terminated. |
| `maxAllowedUnauthenticatedCommands` | `number \| false` | `10` | Maximum commands allowed before authentication. Set to `false` to disable the limit. |

---

## Proxy / X-headers

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `useXClient` | `boolean` | `false` | Trust Postfix `XCLIENT` headers. When enabled, `session.xClient` is populated. |
| `useXForward` | `boolean` | `false` | Trust Postfix `XFORWARD` headers. When enabled, `session.xForward` is populated. |
| `useProxy` | `boolean \| string[]` | `false` | Parse HAProxy `PROXY` protocol header. Pass an array of trusted proxy IP addresses to restrict which proxies are trusted. |

---

## DNS

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `disableReverseLookup` | `boolean` | `false` | Skip reverse DNS lookup on new connections. When `false`, `session.clientHostname` is resolved from the client's IP. |
| `resolver` | `object` | — | Custom DNS resolver. Must implement `reverse(ip, callback)` with the same signature as `dns.reverse`. |

---

## TLS

All standard TLS options. See [TLS & STARTTLS](/guide/tls) for usage examples.

| Option | Type | Description |
|--------|------|-------------|
| `key` | `string \| Buffer` | Private key (PEM) |
| `cert` | `string \| Buffer` | Certificate (PEM) |
| `ca` | `string \| Buffer \| Array` | CA bundle for client cert verification |
| `requestCert` | `boolean` | Request a client certificate during TLS handshake |
| `rejectUnauthorized` | `boolean` | Reject clients with invalid or unverifiable certificates |
| `minVersion` | `string` | Minimum TLS version string (e.g. `"TLSv1.2"`) |
| `maxVersion` | `string` | Maximum TLS version string |
| `sniOptions` | `Record<string, TLSOptions> \| Map<string, TLSOptions>` | Per-hostname TLS configuration for SNI |

---

## Callbacks

All lifecycle callbacks can be set as constructor options:

| Option | Type | Description |
|--------|------|-------------|
| `onConnect` | `OnConnectCallback` | Called on new connection |
| `onSecure` | `OnSecureCallback` | Called after TLS handshake |
| `onAuth` | `OnAuthCallback` | Called on AUTH attempt |
| `onMailFrom` | `OnMailFromCallback` | Called on MAIL FROM |
| `onRcptTo` | `OnRcptToCallback` | Called on RCPT TO |
| `onData` | `OnDataCallback` | Called when DATA transfer begins |
| `onClose` | `OnCloseCallback` | Called when connection closes |

See [Callbacks](/reference/callbacks) for full signatures and examples.
