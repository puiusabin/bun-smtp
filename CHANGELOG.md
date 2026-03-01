# Changelog

## [0.3.0](https://github.com/puiusabin/bun-smtp/compare/v0.2.0...v0.3.0) (2026-03-01)


### Features

* add typed overloads for listen() ([4b02ecc](https://github.com/puiusabin/bun-smtp/commit/4b02eccfc30c7be39fd05cd917e060175b1f2419))


### Bug Fixes

* use Infinity sentinel and set sizeExceeded progressively ([eb9bf7a](https://github.com/puiusabin/bun-smtp/commit/eb9bf7a59c29c98d7737923225e8389d185a0b9f))

## [0.2.0](https://github.com/puiusabin/bun-smtp/compare/v0.1.1...v0.2.0) (2026-02-27)


### Features

* add types, auth helpers, and package config ([69d6b94](https://github.com/puiusabin/bun-smtp/commit/69d6b943fb3ab79ee60e6fea581906946ab650df))
* **address-parser:** add RFC 5321 address parser with local-part and domain validation ([745c371](https://github.com/puiusabin/bun-smtp/commit/745c371398028cdc829c047d9e01878c9ab9ae54))
* **bench:** add head-to-head throughput benchmark vs smtp-server ([197dcbb](https://github.com/puiusabin/bun-smtp/commit/197dcbb1ddda0f780f86d49452e34c021293490a))
* **bench:** run smtp-server in a real Node.js process for an honest comparison ([816d42c](https://github.com/puiusabin/bun-smtp/commit/816d42c7165cd08383faf04e69070af1be460ab1))
* **connection:** add SMTP connection state machine with auth, TLS, and pipelining support ([a43c7f9](https://github.com/puiusabin/bun-smtp/commit/a43c7f983dabd829775345a378930a87366c91a5))
* **smtp-parser:** add stateful command and data mode parser with dot-unstuffing ([1ac3f53](https://github.com/puiusabin/bun-smtp/commit/1ac3f53a029db44b4b699cf00040afb297f6b401))
* **smtp-server:** add Bun-native SMTP server with TLS, auth, and graceful close ([3f23d23](https://github.com/puiusabin/bun-smtp/commit/3f23d23c4179794c3a5a16820110f3271f17bd3b))


### Bug Fixes

* normalize repository url in package.json ([aea7748](https://github.com/puiusabin/bun-smtp/commit/aea7748a90bc235f8fe25d63879aa472f768c7b5))
* remove smtp-server package ([27aeee0](https://github.com/puiusabin/bun-smtp/commit/27aeee05302bc2d6f0a26debd1d23cc9449aff6c))
* **test:** cast remainder through unknown to resolve never narrowing ([e445445](https://github.com/puiusabin/bun-smtp/commit/e44544530bbcdd9015baab2dcea8d04598514450))
* **test:** use explicit false check for type narrowing ([2bef042](https://github.com/puiusabin/bun-smtp/commit/2bef0422965b42822524f9cb1308f2c394016f42))
* **test:** use explicit false check to satisfy biome lint ([e86e3df](https://github.com/puiusabin/bun-smtp/commit/e86e3df924646f162a0f9fe068de499a392b1f66))


### Performance Improvements

* add disabledCommandsSet and lastActivity fields ([980ba89](https://github.com/puiusabin/bun-smtp/commit/980ba892c477a15b76310131056634fbc2a1202e))
* **bench:** use persistent connections with RSET to eliminate TCP handshake overhead ([e43f5e2](https://github.com/puiusabin/bun-smtp/commit/e43f5e2a17210bbd2d9f40ba5ed2ea1f128ab3a5))
* **connection:** extend pre-built replies, eliminate per-command allocations ([1a88e65](https://github.com/puiusabin/bun-smtp/commit/1a88e654efef20bf80e894446e0de1c342ca5afc))
* **connection:** O(1) drain loop and timestamp-based timeout ([768447e](https://github.com/puiusabin/bun-smtp/commit/768447e956a4a3e165db7455c3e148786cd0c7cd))
* **connection:** pre-build hot reply strings, avoid regex in command parsing ([96a9d23](https://github.com/puiusabin/bun-smtp/commit/96a9d2358675d00464d5a974f833813af215b094))
* **smtp-parser:** keep remainder as Buffer, replace setImmediate with labeled loop ([fbf3774](https://github.com/puiusabin/bun-smtp/commit/fbf37746b848d541919a239b86d21ae1f1700c28))
* **smtp-parser:** reuse empty buffer constant ([4f1dfae](https://github.com/puiusabin/bun-smtp/commit/4f1dfae567314202874344caefaa72c5832fc0d5))

## [0.1.1](https://github.com/puiusabin/bun-smtp/compare/v0.1.0...v0.1.1) (2026-02-27)


### Bug Fixes

* remove smtp-server package ([27aeee0](https://github.com/puiusabin/bun-smtp/commit/27aeee05302bc2d6f0a26debd1d23cc9449aff6c))
