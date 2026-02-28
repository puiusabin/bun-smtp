# Session & Envelope

Every callback receives a `session` object representing the current connection state.

## SMTPSession

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique connection identifier |
| `secure` | `boolean` | `true` if the connection is currently using TLS |
| `servername` | `string \| undefined` | SNI hostname from the TLS handshake |
| `localAddress` | `string` | Server IP address |
| `localPort` | `number` | Server port |
| `remoteAddress` | `string` | Client IP address |
| `remotePort` | `number` | Client port |
| `clientHostname` | `string` | Reverse-DNS hostname of the client (`"[remoteAddress]"` if lookup fails or is disabled) |
| `hostNameAppearsAs` | `string` | Hostname the client claimed in HELO/EHLO |
| `openingCommand` | `string` | The first command the client sent: `"HELO"`, `"EHLO"`, or `"LHLO"` |
| `transmissionType` | `string` | SMTP transmission type string, e.g. `"ESMTPSA"` |
| `tlsOptions` | `TLSCipherInfo \| false` | Cipher info after TLS is established, `false` before |
| `user` | `unknown` | Value passed as `user` in a successful `onAuth` response |
| `transaction` | `number` | Number of completed mail transactions on this connection |
| `envelope` | `SMTPEnvelope` | Current mail envelope |
| `xClient` | `Map<string, string \| false>` | XCLIENT header values (when `useXClient: true`) |
| `xForward` | `Map<string, string \| false>` | XFORWARD header values (when `useXForward: true`) |

### TLSCipherInfo

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | OpenSSL cipher name |
| `standardName` | `string \| undefined` | IANA cipher name |
| `version` | `string \| undefined` | TLS protocol version |

---

## SMTPEnvelope

Available as `session.envelope`. Populated progressively as the client sends MAIL FROM and RCPT TO commands.

| Field | Type | Description |
|-------|------|-------------|
| `mailFrom` | `SMTPAddress \| false` | Sender address from MAIL FROM, or `false` before MAIL FROM is received |
| `rcptTo` | `SMTPAddress[]` | Accepted recipient addresses from RCPT TO |
| `bodyType` | `"7bit" \| "8bitmime"` | Body encoding declared by the client |
| `smtpUtf8` | `boolean` | `true` if the client declared SMTPUTF8 |
| `requireTLS` | `boolean` | `true` if the client sent REQUIRETLS |
| `dsn` | `DSNEnvelope \| undefined` | DSN envelope parameters |

### DSNEnvelope

| Field | Type | Description |
|-------|------|-------------|
| `ret` | `"FULL" \| "HDRS" \| null` | Return type requested by the client |
| `envid` | `string \| null` | Envelope identifier |

---

## SMTPAddress

Returned by `onMailFrom` and `onRcptTo`, and stored in `session.envelope`.

| Field | Type | Description |
|-------|------|-------------|
| `address` | `string` | The email address |
| `args` | `SMTPAddressArgs \| false` | ESMTP parameters from the command, or `false` if none |
| `dsn` | `DSNRcpt \| undefined` | Per-recipient DSN parameters |

### SMTPAddressArgs

ESMTP parameters parsed from the MAIL FROM or RCPT TO command:

| Field | Type | Description |
|-------|------|-------------|
| `SIZE` | `string \| undefined` | Declared message size in bytes |
| `BODY` | `string \| undefined` | Body type: `"7BIT"` or `"8BITMIME"` |
| `SMTPUTF8` | `true \| undefined` | UTF-8 support flag |
| `REQUIRETLS` | `true \| undefined` | TLS-required flag (RFC 8689) |
| `RET` | `string \| undefined` | DSN return type |
| `ENVID` | `string \| undefined` | DSN envelope ID |
| `NOTIFY` | `string \| undefined` | DSN notification conditions |
| `ORCPT` | `string \| undefined` | DSN original recipient |

Any unrecognized ESMTP parameter is also available as a string or `true` on the args object.

### DSNRcpt

| Field | Type | Description |
|-------|------|-------------|
| `notify` | `string[] \| undefined` | DSN notification conditions (e.g. `["SUCCESS", "FAILURE"]`) |
| `orcpt` | `string \| undefined` | Original recipient address |

---

## Example

```ts
const server = new SMTPServer({
  onData(stream, session, callback) {
    const { envelope } = session;
    console.log("From:", envelope.mailFrom && envelope.mailFrom.address);
    console.log("To:", envelope.rcptTo.map((r) => r.address));
    console.log("Secure:", session.secure);
    console.log("User:", session.user);

    stream.pipeTo(new WritableStream()).then(() => callback(null), callback);
  },
});
```
