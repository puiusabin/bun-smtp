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
  - icon: 🐰
    title: Bun-native
    details: Built on Bun.listen(), socket.upgradeTLS(), and Bun.CryptoHasher. No Node.js compat layer.
  - icon: 🔄
    title: Drop-in replacement
    details: Same constructor options, callbacks, and event names as the smtp-server npm package. Minimal migration effort.
  - icon: 📨
    title: Full SMTP support
    details: HELO, EHLO, MAIL FROM, RCPT TO, DATA, STARTTLS, LMTP, pipelining, DSN, and enhanced status codes.
  - icon: 😃
    title: TypeScript-first
    details: Fully typed API with strong types throughout. Callbacks, sessions, and envelopes are all strongly typed.
---
