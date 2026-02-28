---
layout: home

hero:
  name: bun-smtp
  text: SMTP server for Bun
  tagline: Drop-in replacement for smtp-server. Zero dependencies. Bun-native.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/puiusabin/bun-smtp

features:
  - title: Bun-native
    details: Built on Bun.listen(), socket.upgradeTLS(), and Bun.CryptoHasher. No Node.js compat layer.
  - title: Drop-in replacement
    details: Same constructor options, callbacks, and event names as the smtp-server npm package. Minimal migration effort.
  - title: Full SMTP support
    details: HELO, EHLO, MAIL FROM, RCPT TO, DATA, STARTTLS, LMTP, pipelining, DSN, and enhanced status codes.
  - title: SASL auth
    details: PLAIN, LOGIN, CRAM-MD5, and XOAUTH2 out of the box.
  - title: TypeScript-first
    details: Fully typed API with strong types throughout. No any casts.
  - title: Zero dependencies
    details: No runtime dependencies. Just bun-smtp and Bun.
---
