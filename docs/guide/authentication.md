# Authentication

## Configuration

Control which SASL methods clients may use:

```ts
const server = new SMTPServer({
  authMethods: ["PLAIN", "LOGIN", "CRAM-MD5", "XOAUTH2"],
  allowInsecureAuth: false, // require TLS before AUTH (default)
  authOptional: false,      // require AUTH (default)
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `authMethods` | `string[]` | `["PLAIN", "LOGIN"]` | Allowed SASL methods |
| `authOptional` | `boolean` | `false` | Allow unauthenticated sessions |
| `allowInsecureAuth` | `boolean` | `false` | Allow AUTH over plain TCP (no TLS) |
| `authRequiredMessage` | `string` | — | Custom message for 530 response |

The `onAuth` callback is called for every AUTH attempt. Call `callback(null, { user })` to accept or `callback(new Error("reason"))` to reject.

## PLAIN and LOGIN

Both methods deliver credentials in the same `auth` object:

```ts
const server = new SMTPServer({
  authMethods: ["PLAIN", "LOGIN"],
  onAuth(auth, session, callback) {
    if (auth.method !== "PLAIN" && auth.method !== "LOGIN") {
      return callback(new Error("Unsupported method"));
    }
    if (auth.username === "user" && auth.password === "secret") {
      callback(null, { user: auth.username });
    } else {
      callback(new Error("Invalid credentials"));
    }
  },
});
```

`auth` fields for PLAIN/LOGIN:

| Field | Type | Description |
|-------|------|-------------|
| `method` | `"PLAIN" \| "LOGIN"` | Which method the client used |
| `username` | `string` | Decoded username |
| `password` | `string` | Decoded password |

## CRAM-MD5

CRAM-MD5 does not transmit the password. The server sends a challenge, the client responds with an HMAC-MD5 digest. Use `auth.validatePassword()` to verify:

```ts
const server = new SMTPServer({
  authMethods: ["CRAM-MD5"],
  onAuth(auth, session, callback) {
    if (auth.method !== "CRAM-MD5") {
      return callback(new Error("Unsupported method"));
    }
    const storedPassword = lookupPassword(auth.username);
    if (auth.validatePassword(storedPassword)) {
      callback(null, { user: auth.username });
    } else {
      callback(new Error("Invalid credentials"));
    }
  },
});
```

`auth` fields for CRAM-MD5:

| Field | Type | Description |
|-------|------|-------------|
| `method` | `"CRAM-MD5"` | |
| `username` | `string` | |
| `challenge` | `string` | The server-generated challenge string |
| `challengeResponse` | `string` | The raw response from the client |
| `validatePassword(password)` | `(string) => boolean` | Returns `true` if the password matches |

## XOAUTH2

XOAUTH2 is used with OAuth2 access tokens:

```ts
const server = new SMTPServer({
  authMethods: ["XOAUTH2"],
  onAuth(auth, session, callback) {
    if (auth.method !== "XOAUTH2") {
      return callback(new Error("Unsupported method"));
    }
    verifyToken(auth.username, auth.accessToken)
      .then((user) => callback(null, { user }))
      .catch(() => {
        // Return data to trigger the XOAUTH2 re-challenge
        callback(new Error("Invalid token"), {
          data: { status: "401", schemes: "bearer", scope: "mail" },
        });
      });
  },
});
```

`auth` fields for XOAUTH2:

| Field | Type | Description |
|-------|------|-------------|
| `method` | `"XOAUTH2"` | |
| `username` | `string` | |
| `accessToken` | `string` | OAuth2 bearer token |

When authentication fails, you can pass a `data` object in the response to trigger an XOAUTH2 error challenge back to the client.

## Storing the authenticated user

Whatever you pass as `user` in the success response is available on `session.user` for the rest of the connection:

```ts
callback(null, { user: { id: 42, email: "user@example.com" } });

// later in onData:
function onData(stream, session, callback) {
  console.log(session.user); // { id: 42, email: 'user@example.com' }
}
```
