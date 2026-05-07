# Changelog

## [0.9.0](https://github.com/lonix/koolbot/compare/v0.8.0...v0.9.0) (2026-05-07)


### 🚀 Features

* **voice:** button-driven voice channel presets ([#364](https://github.com/lonix/koolbot/issues/364)) ([#366](https://github.com/lonix/koolbot/issues/366)) ([36b8636](https://github.com/lonix/koolbot/commit/36b86364916b67ff0dceb62636c900312633440c))


### 🐛 Bug Fixes

* **ci:** bump trivy-action to v0.36.0 (current latest) ([#358](https://github.com/lonix/koolbot/issues/358)) ([f563eff](https://github.com/lonix/koolbot/commit/f563eff4a884cae0c69c30e675a1c0e4c8f61044))
* **ci:** unblock docker hadolint SARIF upload and bootstrap release-please at 0.8.0 ([#356](https://github.com/lonix/koolbot/issues/356)) ([4b2d8db](https://github.com/lonix/koolbot/commit/4b2d8db6520107c97c4bcd0783f028d7d7950c5a))
* **command-manager:** replace blind error cast with DiscordAPIError type guards ([#370](https://github.com/lonix/koolbot/issues/370)) ([0fbe8bf](https://github.com/lonix/koolbot/commit/0fbe8bf21aae49e1291dc097bfc0bb75f1cc5ad8))
* remove stray AI artifact and hoist mongoose import in src/index.ts ([#340](https://github.com/lonix/koolbot/issues/340)) ([4e5a1ba](https://github.com/lonix/koolbot/commit/4e5a1badec2667ce5a31c873c586594e3f0a11c9))
* **services:** clear long-lived timers during graceful shutdown ([#371](https://github.com/lonix/koolbot/issues/371)) ([592362c](https://github.com/lonix/koolbot/commit/592362c92a21e936b2df2c7000d53a42ab1c2be6))
* **test:** use ESM-compatible mocks in config-service-methods test ([#348](https://github.com/lonix/koolbot/issues/348)) ([a0d157f](https://github.com/lonix/koolbot/commit/a0d157f48fa22937005d23590693d2db7c55d7d7))
* **voice-channels:** unify lobby name lookup and recover from setChannel failure ([#354](https://github.com/lonix/koolbot/issues/354)) ([aca280c](https://github.com/lonix/koolbot/commit/aca280ce3896033baf2cd82827d80d51341c0819))


### ♻️ Refactoring

* extract hardcoded content arrays into src/content/ ([#368](https://github.com/lonix/koolbot/issues/368)) ([388db0f](https://github.com/lonix/koolbot/commit/388db0ffca425015b3c658e87cc5356e42fda4e6))
* remove unused MongoClient utility, use mongoose directly in scripts ([#369](https://github.com/lonix/koolbot/issues/369)) ([177789b](https://github.com/lonix/koolbot/commit/177789b7e552cd4894273ecdba6c0d84c4d9b9f3))
* replace pervasive `any` types in achievements + wizard helpers ([#355](https://github.com/lonix/koolbot/issues/355)) ([5bed293](https://github.com/lonix/koolbot/commit/5bed29357d6e6449c5ccb8eeaaa948840c0e3c32))


### ⚙️ CI/CD

* modernize pipeline with parallel jobs and supply-chain hardening ([#341](https://github.com/lonix/koolbot/issues/341)) ([b9add79](https://github.com/lonix/koolbot/commit/b9add79228c27c16cd70dfc146a13054d5ee508a))
* replace release-drafter with googleapis/release-please-action ([#347](https://github.com/lonix/koolbot/issues/347)) ([b8c2f3d](https://github.com/lonix/koolbot/commit/b8c2f3d51253a8720a2d4113bdacf677e19c978d))


### 🔧 Maintenance

* raise Jest coverage thresholds incrementally from 2% toward 70-80% goal ([#336](https://github.com/lonix/koolbot/issues/336)) ([fbece05](https://github.com/lonix/koolbot/commit/fbece05edc9c884e682ffeed9e3749d1d87b747c))
* remove dead `private db: any` field from `VoiceChannelTracker` ([#338](https://github.com/lonix/koolbot/issues/338)) ([d978097](https://github.com/lonix/koolbot/commit/d9780978754ac818741922d12f869b3fc620eb8d))
* remove redundant `@types/mongoose` dev dependency ([#337](https://github.com/lonix/koolbot/issues/337)) ([5307411](https://github.com/lonix/koolbot/commit/5307411c2cef3d4dbf7df4fa250ba8cb5e41b509))
