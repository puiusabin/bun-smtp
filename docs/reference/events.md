# Events

`SMTPServer` is an event emitter. Use `server.on()`, `server.once()`, and `server.off()` to manage listeners.

---

## listening

Emitted when the server has bound to a port and is ready to accept connections.

```ts
server.on("listening", () => {
  console.log("Server is ready");
});

await server.listen(2525);
```

---

## close

Emitted when the server has fully shut down — all connections have closed and the port has been released.

```ts
server.on("close", () => {
  console.log("Server stopped");
});

server.close();
```

---

## error

Emitted on server-level errors (e.g. port already in use, TLS failures). Always attach an error listener to prevent unhandled rejection crashes.

```ts
server.on("error", (err) => {
  console.error("SMTP server error:", err);
});
```

The error object may include:
- `err.responseCode` — SMTP status code
- `err.code` — error code string
- `err.meta` — additional context

---

## connect

Emitted when a new client connection is accepted (after `onConnect` succeeds).

```ts
server.on("connect", (info) => {
  console.log(`New connection from ${info.remoteAddress}:${info.remotePort}`);
});
```

The `info` object (`ConnectionInfo`):

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique connection identifier |
| `localAddress` | `string` | Server IP |
| `localPort` | `number` | Server port |
| `remoteAddress` | `string` | Client IP |
| `remotePort` | `number` | Client port |
| `clientHostname` | `string` | Reverse-DNS hostname of the client |
| `hostNameAppearsAs` | `string` | Hostname from HELO/EHLO (populated after the opening command) |
