# Getting Started

## Installation

```sh
bun add bun-smtp
```

Requires Bun 1.2.0 or later.

## Minimal server

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
console.log("SMTP server listening on port 2525");
```

The server sends a `220` greeting on connect. Clients can now send mail without authenticating.

## Accepting authenticated connections

```ts
import { SMTPServer } from "bun-smtp";

const server = new SMTPServer({
  onAuth(auth, session, callback) {
    if (auth.username === "user" && auth.password === "pass") {
      callback(null, { user: auth.username });
    } else {
      callback(new Error("Invalid credentials"));
    }
  },
  onData(stream, session, callback) {
    // consume the message body
    stream.pipeTo(new WritableStream()).then(() => callback(null), callback);
  },
});

await server.listen(587);
```

## server.listen()

```ts
server.listen(port: number, hostname?: string, callback?: () => void): Promise<void>
```

Binds the server to the given port. Resolves once the server is ready to accept connections. Also emits the `"listening"` event.

- `port` — TCP port to bind
- `hostname` — defaults to `"0.0.0.0"`
- `callback` — optional callback alternative to awaiting the promise

## server.close()

```ts
server.close(callback?: (err?: Error) => void): void
```

Stops accepting new connections and waits for existing connections to close. The server emits `"close"` when all connections have drained.

- Connections idle for longer than `closeTimeout` (default: 30 s) are forcibly terminated.
- `callback` is called once the server has fully shut down.

## server.updateSecureContext()

```ts
server.updateSecureContext(options: TLSOptions): void
```

Hot-reloads TLS credentials without restarting. Pass the same `key`, `cert`, and `ca` fields you would set at construction time. Useful for certificate rotation.
