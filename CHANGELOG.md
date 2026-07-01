# Changelog

## [2.0.0](https://github.com/lonix/koolbot/compare/v1.2.2...v2.0.0) (2026-07-01)


### ⚠ BREAKING CHANGES

* **polls:** drop URL import in favour of file/paste-only import ([#652](https://github.com/lonix/koolbot/issues/652))

### 🚀 Features

* **achievements:** add progress indicators and activate reserved weekly achievements ([#685](https://github.com/lonix/koolbot/issues/685)) ([b8528be](https://github.com/lonix/koolbot/commit/b8528be0ad000821a77f72eec6420bcda4824cb5))
* **announcements:** one-off "post now" sends + expanded placeholder set ([#712](https://github.com/lonix/koolbot/issues/712)) ([34f2568](https://github.com/lonix/koolbot/commit/34f2568583118e826c6d9565a7aa4d1111f8e4c8))
* **birthdays:** celebrate member birthdays in their own timezone ([#670](https://github.com/lonix/koolbot/issues/670)) ([5325a3a](https://github.com/lonix/koolbot/commit/5325a3a70e40d1b30677c3cdbc5f6c5ec3cbe9fd))
* **celebrations:** announce marquee accolade milestones server-wide ([#657](https://github.com/lonix/koolbot/issues/657)) ([#683](https://github.com/lonix/koolbot/issues/683)) ([9e25697](https://github.com/lonix/koolbot/commit/9e256976e0dabba3c38848fa251e9830dceec907))
* declare feature dependencies via dependsOn in SettingMetadata ([#669](https://github.com/lonix/koolbot/issues/669)) ([1bc4f5c](https://github.com/lonix/koolbot/commit/1bc4f5cec1bf14931b19c054e6c26fa88c42bdae))
* **digest:** add Web UI digest preview and send-now page ([#668](https://github.com/lonix/koolbot/issues/668)) ([a90821e](https://github.com/lonix/koolbot/commit/a90821eea1d07843cf5b06923272e1635a657426))
* enforce feature dependencies on write ([#672](https://github.com/lonix/koolbot/issues/672)) ([7ca3c5f](https://github.com/lonix/koolbot/commit/7ca3c5f3f31d588ee8238eff9e36589b7d2250c1))
* **events:** scheduled events with temporary voice channels and RSVPs ([#717](https://github.com/lonix/koolbot/issues/717)) ([890e156](https://github.com/lonix/koolbot/commit/890e156194fc79abf0b5dac2df79769dbc318007))
* make time-of-day and day-of-week accolades timezone-aware ([#660](https://github.com/lonix/koolbot/issues/660)) ([b8a4190](https://github.com/lonix/koolbot/commit/b8a41900b235c24ce48642c34f28deb6b44ccaa6))
* **monitoring:** persist command metrics to MongoDB with admin dashboard ([#651](https://github.com/lonix/koolbot/issues/651)) ([5487e15](https://github.com/lonix/koolbot/commit/5487e15ff4d07a7493b0997b0bd9f48d182d3361))
* **polls:** drop URL import in favour of file/paste-only import ([#652](https://github.com/lonix/koolbot/issues/652)) ([81034a1](https://github.com/lonix/koolbot/commit/81034a15e4e6c8d39e98993d4c42510bf7d0045c))
* **polls:** surface poll participation on Rewind, /me overview, and accolades ([#697](https://github.com/lonix/koolbot/issues/697)) ([3fccd20](https://github.com/lonix/koolbot/commit/3fccd201336cb202362f46bce7373b50790fcc2b))
* **privacy:** never DM users unprompted — make notification DMs opt-in (default off) ([#699](https://github.com/lonix/koolbot/issues/699)) ([eb91e7a](https://github.com/lonix/koolbot/commit/eb91e7a1335f05768b785a86cd440078e68aaac3))
* **rewind:** gate voice and achievements sections on their source feature ([#679](https://github.com/lonix/koolbot/issues/679)) ([9fdee79](https://github.com/lonix/koolbot/commit/9fdee795966d2399a4068a6ecbe2b747a45851f6))
* **rewind:** split rewind.enabled into feature and nudge gates ([#624](https://github.com/lonix/koolbot/issues/624)) ([48781e1](https://github.com/lonix/koolbot/commit/48781e17a5d3026d56448577de58e3d7c7cbf3e2))
* **rewind:** voice activity heatmap — hour-of-day & day-of-week patterns ([#698](https://github.com/lonix/koolbot/issues/698)) ([7ef23df](https://github.com/lonix/koolbot/commit/7ef23dfab495b27b78fffefdbf399120897708b8))
* **scripts:** add sample-data seeder for dev/test databases ([#671](https://github.com/lonix/koolbot/issues/671)) ([f431e0f](https://github.com/lonix/koolbot/commit/f431e0fd247d2d9131618b9e5ec69ca8571278d1))
* surface reaction activity on Rewind year-in-review ([#677](https://github.com/lonix/koolbot/issues/677)) ([91f6d3a](https://github.com/lonix/koolbot/commit/91f6d3a54f2e0cf8856291ef3fd78bdd72627e7a))
* **voice:** apply user name pattern and add /me/voice preset management ([#661](https://github.com/lonix/koolbot/issues/661)) ([3865ff5](https://github.com/lonix/koolbot/commit/3865ff5cb35dfbed195a926e5551febeae49b219))
* **web:** bring setup wizard to parity with the Settings page controls ([#715](https://github.com/lonix/koolbot/issues/715)) ([2bc0cc2](https://github.com/lonix/koolbot/commit/2bc0cc20ddb6b02635b0c980900ebb57c2bfc556))
* **web:** sort enabled features above disabled in wizard and nav ([#710](https://github.com/lonix/koolbot/issues/710)) ([29d6c1a](https://github.com/lonix/koolbot/commit/29d6c1a38a8ca6a13cb8a0b6d7ff3af6eb8617b5)), closes [#706](https://github.com/lonix/koolbot/issues/706)
* **webui:** grey out settings toggles with unmet dependencies and a "requires X" hint ([#695](https://github.com/lonix/koolbot/issues/695)) ([e2e0f0b](https://github.com/lonix/koolbot/commit/e2e0f0b3fc07734ff5a0b188bf5a6c38a0ef7bdc))
* **webui:** group admin sidebar nav into labelled sections ([#640](https://github.com/lonix/koolbot/issues/640)) ([8d63152](https://github.com/lonix/koolbot/commit/8d6315229b3f2ab85fa59834975a52b6b7281e29))
* **webui:** make disabled-feature handling consistent across /me/* pages ([#716](https://github.com/lonix/koolbot/issues/716)) ([8244713](https://github.com/lonix/koolbot/commit/8244713f22217a1882d06d0b1def590078bb7a99))
* **webui:** make Voice Channels settings editable in place ([#714](https://github.com/lonix/koolbot/issues/714)) ([0980de2](https://github.com/lonix/koolbot/commit/0980de21f44f2fa9259ec7b45709e9bf6e451956))
* **webui:** surface disabled feature pages in admin nav with enable prompt ([#643](https://github.com/lonix/koolbot/issues/643)) ([4f048fe](https://github.com/lonix/koolbot/commit/4f048fedf88c393c9af5887548259bb24d97d197))
* wire up quotes.clear_on_sync to rebuild the quote channel on sync ([#676](https://github.com/lonix/koolbot/issues/676)) ([950146f](https://github.com/lonix/koolbot/commit/950146f414b04416449cdb4723f3729de7525dcd))


### 🐛 Bug Fixes

* **deps:** bump undici to ^7.28.0 — clears 7 Trivy + 7 Dependabot alerts ([#694](https://github.com/lonix/koolbot/issues/694)) ([c0fc0de](https://github.com/lonix/koolbot/commit/c0fc0de99dc02f911c2e8458d1fcf3670c286085))
* **deps:** force brace-expansion &gt;=5.0.6 to resolve GHSA-jxxr-4gwj-5jf2 ([#638](https://github.com/lonix/koolbot/issues/638)) ([0cb2b2c](https://github.com/lonix/koolbot/commit/0cb2b2ccafd8e51781536ddd5a6bff8e611b425a))
* **deps:** refresh base-image npm to clear bundled undici/tar Trivy alerts ([#696](https://github.com/lonix/koolbot/issues/696)) ([f29666d](https://github.com/lonix/koolbot/commit/f29666d928b73259a49bcd6ed668cc6191c1350b))
* **deps:** resolve remaining npm audit findings (ws / markdown-it / js-yaml / @babel/core toolchain) ([#641](https://github.com/lonix/koolbot/issues/641)) ([4666f89](https://github.com/lonix/koolbot/commit/4666f89a3b5289adc8fd21845033aecebc223b5b)), closes [#639](https://github.com/lonix/koolbot/issues/639)
* make birthday day a month-aware dropdown for consistent input ([#711](https://github.com/lonix/koolbot/issues/711)) ([ee1ac1b](https://github.com/lonix/koolbot/commit/ee1ac1bcf5e90dd31c780c395873d06fb3ec950b))
* **monitoring:** unref periodic logging interval so it can't block shutdown ([#650](https://github.com/lonix/koolbot/issues/650)) ([7dbfbb0](https://github.com/lonix/koolbot/commit/7dbfbb079f1552cc3c4ff87c23ad1ebf2f5dc907)), closes [#647](https://github.com/lonix/koolbot/issues/647)
* **voice:** re-create lobby immediately after rename deletes the old one ([#632](https://github.com/lonix/koolbot/issues/632)) ([469d057](https://github.com/lonix/koolbot/commit/469d057ecbe8800dd392c1e2be7776b211c1b555)), closes [#631](https://github.com/lonix/koolbot/issues/631)
* warn and short-circuit when leaderboard/digest/achievements run with voice tracking disabled ([#678](https://github.com/lonix/koolbot/issues/678)) ([6722fac](https://github.com/lonix/koolbot/commit/6722fac43bb37798b426f3e45f3fb0d45ebeafcf))
* **wizard:** correct interval type and harden cleanup timer ([#649](https://github.com/lonix/koolbot/issues/649)) ([c41137f](https://github.com/lonix/koolbot/commit/c41137f77bfff6102ebe5dd40fecb488b79f97be)), closes [#645](https://github.com/lonix/koolbot/issues/645)
* **wizard:** render channel/category/role keys as proper selectors ([#713](https://github.com/lonix/koolbot/issues/713)) ([ae5871a](https://github.com/lonix/koolbot/commit/ae5871a65b3a6328e067fab2d87b7496bbfff257))


### 📚 Documentation

* note benign glob deprecation warning from Jest toolchain ([#636](https://github.com/lonix/koolbot/issues/636)) ([b9685ae](https://github.com/lonix/koolbot/commit/b9685aed5d5d3933d59336356b83d5a969a5720e)), closes [#605](https://github.com/lonix/koolbot/issues/605)
* remove undocumented quotes.add_roles config key references ([#701](https://github.com/lonix/koolbot/issues/701)) ([796b6d5](https://github.com/lonix/koolbot/commit/796b6d54cf1723b7438ffaf7ecd909b31e03e3d3)), closes [#680](https://github.com/lonix/koolbot/issues/680)
* require rebase before PR and resolving handled review comments ([#700](https://github.com/lonix/koolbot/issues/700)) ([1f19053](https://github.com/lonix/koolbot/commit/1f19053e497419f343518232d91231e564bdd835))


### 🏗️ Build

* **deps:** bump Docker base image to node:24-alpine ([#634](https://github.com/lonix/koolbot/issues/634)) ([4881f06](https://github.com/lonix/koolbot/commit/4881f06d0b01abc897296fe412b08c0a24c9bc79))
* **docker:** drop no-op OpenSSL stopgap now node:24-alpine is patched ([#642](https://github.com/lonix/koolbot/issues/642)) ([b44a72f](https://github.com/lonix/koolbot/commit/b44a72f129071ffd2e1be6c92439d3815c014700)), closes [#604](https://github.com/lonix/koolbot/issues/604)


### ⚙️ CI/CD

* **deps:** add Dependabot security-updates group for npm ([#687](https://github.com/lonix/koolbot/issues/687)) ([bc284dd](https://github.com/lonix/koolbot/commit/bc284ddc8e8cb57146af8d344cae34e5bae5f512)), closes [#684](https://github.com/lonix/koolbot/issues/684)


### 🔧 Maintenance

* **deps:** bump lagging direct dependencies to latest in-range ([#637](https://github.com/lonix/koolbot/issues/637)) ([e800727](https://github.com/lonix/koolbot/commit/e800727ab63586ac378958b055409a00d16ae359)), closes [#602](https://github.com/lonix/koolbot/issues/602)

## [1.2.2](https://github.com/lonix/koolbot/compare/v1.2.1...v1.2.2) (2026-06-15)


### 🐛 Bug Fixes

* **webui:** send settings section save as urlencoded so CSRF token survives ([#629](https://github.com/lonix/koolbot/issues/629)) ([13a23b8](https://github.com/lonix/koolbot/commit/13a23b85dbe4031af76955781baded0d9ce7ff42))

## [1.2.1](https://github.com/lonix/koolbot/compare/v1.2.0...v1.2.1) (2026-06-15)


### 🐛 Bug Fixes

* prime VC user count at startup so presence reflects voice occupancy ([#622](https://github.com/lonix/koolbot/issues/622)) ([949bcc5](https://github.com/lonix/koolbot/commit/949bcc56a8688a0f3c6e1b5f9ce475b1719f5b03))
* **rewind:** resolve voice companions to stored username, skip nameless ids ([#619](https://github.com/lonix/koolbot/issues/619)) ([86e6f52](https://github.com/lonix/koolbot/commit/86e6f525a9a99232bb4f1ece0ad97910a86c501b))
* stop cleanup sweep from purging valid polls/notices settings ([#616](https://github.com/lonix/koolbot/issues/616)) ([ddced25](https://github.com/lonix/koolbot/commit/ddced2568a0db08bbb190504b24d0ede0f378b90))
* **voice:** persist and restore dynamic channel ownership across restarts ([#620](https://github.com/lonix/koolbot/issues/620)) ([78c51bc](https://github.com/lonix/koolbot/commit/78c51bcc8862e0caaa6493bfef44af7bf5bcaed8))
* **web:** even out Rewind stat card grid wrap ([#617](https://github.com/lonix/koolbot/issues/617)) ([9c686ee](https://github.com/lonix/koolbot/commit/9c686eedab3124d2e8f4b50e924225b67530f922)), closes [#607](https://github.com/lonix/koolbot/issues/607)
* **web:** surface real error detail on settings save failures ([#618](https://github.com/lonix/koolbot/issues/618)) ([6a6f80a](https://github.com/lonix/koolbot/commit/6a6f80addfc165641d39aa91ae7d486d2030bea0))
* **webui:** excluded-voice picker lists voice channels, not text ([#623](https://github.com/lonix/koolbot/issues/623)) ([a801bad](https://github.com/lonix/koolbot/commit/a801badff9dad90bba6704ce369e72f5da62d17b))

## [1.2.0](https://github.com/lonix/koolbot/compare/v1.1.0...v1.2.0) (2026-06-12)


### 🚀 Features

* **quotes:** backup/restore, channel reset, and persistent vote tallies ([#561](https://github.com/lonix/koolbot/issues/561)) ([ced5e95](https://github.com/lonix/koolbot/commit/ced5e95cf213a251d0e439873dc0d47dbc31b80d))
* resolve emoji shortcodes in VC name config values ([#558](https://github.com/lonix/koolbot/issues/558)) ([#563](https://github.com/lonix/koolbot/issues/563)) ([6858878](https://github.com/lonix/koolbot/commit/6858878bf81df758d2fea39b43807f1bf8ffa110))
* **rewind:** add longest single voice session to year-in-review ([#589](https://github.com/lonix/koolbot/issues/589)) ([d275779](https://github.com/lonix/koolbot/commit/d27577965901aa86a2ea2d0b711a56c1fe6809e8)), closes [#568](https://github.com/lonix/koolbot/issues/568)
* **rewind:** cover a full year by default and warn on low retention ([#579](https://github.com/lonix/koolbot/issues/579)) ([6f69818](https://github.com/lonix/koolbot/commit/6f69818508017d46edff324cd85e68728071b0eb))
* **rewind:** default bare /me/rewind to the most recent year with data ([#581](https://github.com/lonix/koolbot/issues/581)) ([be9f44a](https://github.com/lonix/koolbot/commit/be9f44a226d4ae40cc1b34a50933c4ccd080f5f9))
* **rewind:** replace Top channels with a Top voice companions card ([#578](https://github.com/lonix/koolbot/issues/578)) ([0565778](https://github.com/lonix/koolbot/commit/0565778eef728646fbeb4c4f29105a6881539f29))
* **rewind:** snapshot completed-year recaps at rollover (retention-proof) ([#580](https://github.com/lonix/koolbot/issues/580)) ([a1ab66d](https://github.com/lonix/koolbot/commit/a1ab66dad666247f451d172db10a5c7b9cb0ccee))
* **tracking:** capture reactions, poll votes, and voice companion overlap when enabled ([#582](https://github.com/lonix/koolbot/issues/582)) ([bd93eb7](https://github.com/lonix/koolbot/commit/bd93eb7c929b051d7956d344558b26d66b1c37c2))
* **web:** let admins paste a poll library to import without hosting it ([#565](https://github.com/lonix/koolbot/issues/565)) ([c98cc01](https://github.com/lonix/koolbot/commit/c98cc0122a3a6af92b2d68e2d83be537b9ec3626))
* **webui:** DB-backed, editable bot status message pools ([#557](https://github.com/lonix/koolbot/issues/557)) ([#566](https://github.com/lonix/koolbot/issues/566)) ([a441845](https://github.com/lonix/koolbot/commit/a4418457fb1d51f76561b637322425381f807104))
* **webui:** edit existing poll questions and schedules in place ([#572](https://github.com/lonix/koolbot/issues/572)) ([622eba2](https://github.com/lonix/koolbot/commit/622eba22160d0087187050cae3dccb25af28cd92))
* **webui:** keep scroll position when saving a settings section ([#564](https://github.com/lonix/koolbot/issues/564)) ([4bb05d6](https://github.com/lonix/koolbot/commit/4bb05d61dcd417e0af8b206e3be81e1aeb7bc8de))


### 🐛 Bug Fixes

* **deps:** bump undici to 7.27.2 to resolve DoS and request smuggling advisories ([#599](https://github.com/lonix/koolbot/issues/599)) ([1ca160e](https://github.com/lonix/koolbot/commit/1ca160e8cf22c380493bac5b396ed9b98bd23833))
* **docker:** upgrade OpenSSL libs in runtime image to clear Trivy CVEs ([#593](https://github.com/lonix/koolbot/issues/593)) ([89dfb65](https://github.com/lonix/koolbot/commit/89dfb65f1f090f1cdd7c49fb90b9b3937e6fc3b0)), closes [#590](https://github.com/lonix/koolbot/issues/590)
* route user-controlled values through sanitizeForLog to clear CodeQL log-injection alerts ([#583](https://github.com/lonix/koolbot/issues/583)) ([89edcd4](https://github.com/lonix/koolbot/commit/89edcd46211c19949b177a956e56c09dfa0a6e1d))
* **webui:** darken pre-auth pages to match admin theme ([#571](https://github.com/lonix/koolbot/issues/571)) ([e8d67f3](https://github.com/lonix/koolbot/commit/e8d67f3989526057f02936af4b7cadde5b190ecd))
* **webui:** drop "currently" prefix from wizard ON/OFF indicator ([#560](https://github.com/lonix/koolbot/issues/560)) ([0943e15](https://github.com/lonix/koolbot/commit/0943e15e3d9001622712dc7beab894e10fa4a880))


### ♻️ Refactoring

* **achievements:** extract formatMetadata helper to fix CodeQL alert ([#596](https://github.com/lonix/koolbot/issues/596)) ([56b3a10](https://github.com/lonix/koolbot/commit/56b3a108c5af605865b2433bb9ef2814a2ab8902))


### 📚 Documentation

* add CLAUDE.md and refresh CI/CD guidance for AI agents ([#562](https://github.com/lonix/koolbot/issues/562)) ([2894efc](https://github.com/lonix/koolbot/commit/2894efc5ea264dce9326170277f2c06b1886a154))


### 📦 Dependencies

* dedupe picomatch to 4.0.4 to clear dev-only ReDoS/method-injection CVEs ([#595](https://github.com/lonix/koolbot/issues/595)) ([a3b824e](https://github.com/lonix/koolbot/commit/a3b824ef61789cdcae2a8a165375a865a9a75328)), closes [#585](https://github.com/lonix/koolbot/issues/585)


### ⚙️ CI/CD

* **docker:** pull fresh base image so rebuilds absorb patched OpenSSL ([#597](https://github.com/lonix/koolbot/issues/597)) ([c44f1ef](https://github.com/lonix/koolbot/commit/c44f1ef6f711c07f75c951be85096c7fdbf95064)), closes [#588](https://github.com/lonix/koolbot/issues/588)
* enforce conventional-commit PR titles so release-please sees every change ([#551](https://github.com/lonix/koolbot/issues/551)) ([3ef7520](https://github.com/lonix/koolbot/commit/3ef7520b651a3b6649817a85dba5805180ff2ce0))
* exclude js/log-injection from CodeQL and drop dead suppressions ([#600](https://github.com/lonix/koolbot/issues/600)) ([5e0a25c](https://github.com/lonix/koolbot/commit/5e0a25c4b32b6312e2d4c58f172010d5e6db1b7e))
* keep CodeQL runs on main from being cancelled ([#598](https://github.com/lonix/koolbot/issues/598)) ([3ee206f](https://github.com/lonix/koolbot/commit/3ee206fc3a8072b8f895bb07533648d3da712da0))

## [1.1.0](https://github.com/lonix/koolbot/compare/v1.0.0...v1.1.0) (2026-06-12)


### 🚀 Features

* per-user display timezone preference ([#549](https://github.com/lonix/koolbot/issues/549)) ([97c2f50](https://github.com/lonix/koolbot/commit/97c2f50629dfba9921765852a0d0a4503ce81529))


### 🐛 Bug Fixes

* cancel pending ownership transfer when channel is cleaned up ([#547](https://github.com/lonix/koolbot/issues/547)) ([254580a](https://github.com/lonix/koolbot/commit/254580a1bc5008d7a1aad144239f68ed84970eff))
* enforce minimum entropy for WEBUI_SESSION_SECRET at startup ([#548](https://github.com/lonix/koolbot/issues/548)) ([2ff71ec](https://github.com/lonix/koolbot/commit/2ff71eccd662a28cf429ee8e51ab645c989cdb86))
* memory leak in CooldownManager by evicting expired entries ([#544](https://github.com/lonix/koolbot/issues/544)) ([90291c0](https://github.com/lonix/koolbot/commit/90291c03cf1d74fd75e0f3b528b54220a82063b1))
* unmanaged-channel scanner deleting renamed channels after ownership transfer ([#543](https://github.com/lonix/koolbot/issues/543)) ([9535f2b](https://github.com/lonix/koolbot/commit/9535f2b7070ce39607f9b6e95fb8db9581b9fd10))


### ♻️ Refactoring

* remove redundant dotenvConfig() calls ([#546](https://github.com/lonix/koolbot/issues/546)) ([c786f60](https://github.com/lonix/koolbot/commit/c786f607142b66124fe9823f1d822f2b2b47bf15))


### 📚 Documentation

* add example poll libraries (starter + Two Maidens dilemmas) ([#550](https://github.com/lonix/koolbot/issues/550)) ([e0f28cc](https://github.com/lonix/koolbot/commit/e0f28cc2b56177ead7b7977767047fe5d947f0fd))


### ⚙️ CI/CD

* surface OCI description on GHCR and fix release-triggered image builds ([#541](https://github.com/lonix/koolbot/issues/541)) ([4c37477](https://github.com/lonix/koolbot/commit/4c37477ff9535800e8c197812aa16c8d2a81493b))

## [1.0.0](https://github.com/lonix/koolbot/compare/v0.9.0...v1.0.0) (2026-06-08)


### ⚠ BREAKING CHANGES

* /amikool is no longer registered with Discord and the amikool.* / fun.friendship settings are no longer recognised. Existing DB rows for these keys become inert and will be reported as "unknown settings" until removed.
* All admin slash commands except `/config web` have been removed. `WEBUI_ENABLED=true` (with the supporting env vars) is now required to administer the bot. Operators must enable the WebUI before upgrading to this release.

### 🚀 Features

* annual rewind year-in-review WebUI + end-of-year DM nudge (closes [#484](https://github.com/lonix/koolbot/issues/484)) ([#494](https://github.com/lonix/koolbot/issues/494)) ([0fb8b19](https://github.com/lonix/koolbot/commit/0fb8b19b71868d7af8f4d0e0d4771be6a4d5ff8c))
* **commands:** deprecate legacy admin slash commands ([#385](https://github.com/lonix/koolbot/issues/385)) ([#406](https://github.com/lonix/koolbot/issues/406)) ([1ed4b0e](https://github.com/lonix/koolbot/commit/1ed4b0ef914c1f7784b222f50466fc0ac4b212b6))
* expose opt-in Prometheus/OpenMetrics endpoint ([#509](https://github.com/lonix/koolbot/issues/509)) ([#514](https://github.com/lonix/koolbot/issues/514)) ([a7fc790](https://github.com/lonix/koolbot/commit/a7fc790ead45f5cb9bf6dcd418fdf47717898105))
* **leaderboard-roles:** auto-assign Discord roles from voice leaderboard ([#403](https://github.com/lonix/koolbot/issues/403)) ([d7d8f16](https://github.com/lonix/koolbot/commit/d7d8f168c4831168a87626e68fcfdb518869b2a8))
* remove /amikool and friendship-listener novelty features ([#449](https://github.com/lonix/koolbot/issues/449)) ([4a7f73d](https://github.com/lonix/koolbot/commit/4a7f73d82246ba896bbf97b42ca018122e81e8f5))
* remove legacy admin slash commands ([#386](https://github.com/lonix/koolbot/issues/386)) ([#414](https://github.com/lonix/koolbot/issues/414)) ([9a67fea](https://github.com/lonix/koolbot/commit/9a67fea93b9d42e51d68b4601ac3236c35a148c3))
* **rewind:** surface text-message stats on /me/rewind ([#496](https://github.com/lonix/koolbot/issues/496)) ([#515](https://github.com/lonix/koolbot/issues/515)) ([9513e58](https://github.com/lonix/koolbot/commit/9513e58860821de4dfd2d9d98936c998ebf16380))
* text-message tracking foundation (per-user, per-channel) ([#504](https://github.com/lonix/koolbot/issues/504)) ([bd1835e](https://github.com/lonix/koolbot/commit/bd1835ef2c7e87745ed849a3b5a7d8276974b301))
* **web:** Discord slash-command audit log + admin viewer (closes [#459](https://github.com/lonix/koolbot/issues/459)) ([#479](https://github.com/lonix/koolbot/issues/479)) ([8c7d108](https://github.com/lonix/koolbot/commit/8c7d1088cd76fc965bafb6ac9419aa50d857377e))
* **web:** per-user notification preferences via /me/notifications (closes [#482](https://github.com/lonix/koolbot/issues/482)) ([#492](https://github.com/lonix/koolbot/issues/492)) ([6732033](https://github.com/lonix/koolbot/commit/6732033e6a49e1c0fd0d829db863db977a2ab42b))
* **webui:** add "Reset all settings to defaults" action ([#487](https://github.com/lonix/koolbot/issues/487)) ([#500](https://github.com/lonix/koolbot/issues/500)) ([96c8e5f](https://github.com/lonix/koolbot/commit/96c8e5fb8e8a41753bd8ac8dc7483563d2420900))
* **webui:** collapse VC cleanup buttons to single "Force VC cleanup" ([#503](https://github.com/lonix/koolbot/issues/503)) ([6a10690](https://github.com/lonix/koolbot/commit/6a10690dfa470041fb666647ec432909c8d57e24))
* **webui:** read-only admin views ([#381](https://github.com/lonix/koolbot/issues/381)) ([#389](https://github.com/lonix/koolbot/issues/389)) ([e881ddc](https://github.com/lonix/koolbot/commit/e881ddc9008c8d9e9f889fcc9bb4b71fe6f80f28))
* **webui:** render fixed-option settings as selectors ([#499](https://github.com/lonix/koolbot/issues/499)) ([a131d23](https://github.com/lonix/koolbot/commit/a131d23b44d2dd45c9238acafc44a924b256772f)), closes [#488](https://github.com/lonix/koolbot/issues/488)
* **webui:** scaffold WebUI behind feature flag with magic-link auth ([#388](https://github.com/lonix/koolbot/issues/388)) ([4cd3be9](https://github.com/lonix/koolbot/commit/4cd3be9ea1739798c0617aa4e34e95d5c7dced6a))
* **webui:** write surface for announcements + polls ([#383](https://github.com/lonix/koolbot/issues/383)) ([#402](https://github.com/lonix/koolbot/issues/402)) ([58ac172](https://github.com/lonix/koolbot/commit/58ac17274632b704c2865abecb66032925bcff45))
* **webui:** writes for reaction roles, notices, dbtrunk, voice channels ([#384](https://github.com/lonix/koolbot/issues/384)) ([#405](https://github.com/lonix/koolbot/issues/405)) ([c9480a3](https://github.com/lonix/koolbot/commit/c9480a3b3116603f98b7a105488aa9bbaecf4e3e))
* **webui:** writes for settings, permissions, YAML import/export, wizard ([#415](https://github.com/lonix/koolbot/issues/415)) ([79d7cfc](https://github.com/lonix/koolbot/commit/79d7cfcfde24f0e7873e0040580c852ef3ec46b1))
* **web:** user-scoped sessions + /me self-service surface (closes [#481](https://github.com/lonix/koolbot/issues/481)) ([#491](https://github.com/lonix/koolbot/issues/491)) ([681f610](https://github.com/lonix/koolbot/commit/681f6106138f6cb3d071c824eb6eda9369a0df26))
* **web:** wizard Previous button + cascading disable on master toggle (closes [#485](https://github.com/lonix/koolbot/issues/485)) ([#498](https://github.com/lonix/koolbot/issues/498)) ([a5482d5](https://github.com/lonix/koolbot/commit/a5482d52ff19ab0b25b6dd4a05d6a2a43dbaf3cd))
* weekly voice-activity digest with WebUI opt-out (closes [#483](https://github.com/lonix/koolbot/issues/483)) ([#493](https://github.com/lonix/koolbot/issues/493)) ([41a8c78](https://github.com/lonix/koolbot/commit/41a8c78f44241d91d5112c6c353ec793d6d45e8b))


### 🐛 Bug Fixes

* bound unbounded `.find({})` service queries to avoid scale regression ([#505](https://github.com/lonix/koolbot/issues/505)) ([#512](https://github.com/lonix/koolbot/issues/512)) ([125b274](https://github.com/lonix/koolbot/commit/125b27499a287d4faa8452e2ba232d9eaf8b754d))
* **config:** consent screen on magic-link redeem so unfurlers don't burn tokens ([#430](https://github.com/lonix/koolbot/issues/430)) ([5652cd0](https://github.com/lonix/koolbot/commit/5652cd0a31cf948e7e7f0386e5619ddcd2d1dd91))
* **config:** drop CSRF check on magic-link redeem POST ([#431](https://github.com/lonix/koolbot/issues/431)) ([54e6560](https://github.com/lonix/koolbot/commit/54e656072ce74c617c74193129590c441ba2ddd2))
* **config:** log /config invocations and web-session redeem outcomes ([#429](https://github.com/lonix/koolbot/issues/429)) ([c92bdf7](https://github.com/lonix/koolbot/commit/c92bdf737cb30cfbddfcfddd7aca4caa41ea3d6e))
* **config:** set cookie Secure flag from WEBUI_BASE_URL scheme, not NODE_ENV ([#432](https://github.com/lonix/koolbot/issues/432)) ([1eca08a](https://github.com/lonix/koolbot/commit/1eca08af4693421459eefcf62b1b48b347cdcba4))
* **config:** treat empty-string env vars as absent (closes [#455](https://github.com/lonix/koolbot/issues/455)) ([#472](https://github.com/lonix/koolbot/issues/472)) ([5516f15](https://github.com/lonix/koolbot/commit/5516f1527731a3239f1c7c816329f417c994dee3))
* **docker:** exclude devDependencies from production image ([#428](https://github.com/lonix/koolbot/issues/428)) ([0e77bda](https://github.com/lonix/koolbot/commit/0e77bdaf0c2f017f39ddc72a5857d704a3b60379)), closes [#410](https://github.com/lonix/koolbot/issues/410)
* enforce server-side length validation on WebUI write routes ([#508](https://github.com/lonix/koolbot/issues/508)) ([#513](https://github.com/lonix/koolbot/issues/513)) ([028f8e5](https://github.com/lonix/koolbot/commit/028f8e530500199401a0ac301c21fb1519e31b02))
* **shutdown:** avoid configService race in gracefulShutdown ([#520](https://github.com/lonix/koolbot/issues/520)) ([#526](https://github.com/lonix/koolbot/issues/526)) ([5234666](https://github.com/lonix/koolbot/commit/5234666b62726bc8904c01bcbb6087fc2135b685))
* validate Content-Type and cap size on poll import fetches ([#510](https://github.com/lonix/koolbot/issues/510)) ([ee17059](https://github.com/lonix/koolbot/commit/ee170598eb11a403cbf911b90c43d8d98fe7a723))
* **voice:** reconcile userChannels when cleanupUserChannel hits 10003 ([#407](https://github.com/lonix/koolbot/issues/407)) ([9b6455a](https://github.com/lonix/koolbot/commit/9b6455a802601d0bb3080f28860ddaf0fee48281))
* **web:** bound long setting values within their cell on Settings page ([#501](https://github.com/lonix/koolbot/issues/501)) ([8efcbc4](https://github.com/lonix/koolbot/commit/8efcbc4107a451003deaaa0a76a5eb1bf4335ce7))
* **web:** extend session expiresAt on redemption (closes [#486](https://github.com/lonix/koolbot/issues/486)) ([#497](https://github.com/lonix/koolbot/issues/497)) ([3e3b017](https://github.com/lonix/koolbot/commit/3e3b017a50aba61ca46de947e2fe86f7188c3c8e))


### ♻️ Refactoring

* **web:** derive PROTECTED_KEYS from shared BOOTSTRAP_VARS (closes [#457](https://github.com/lonix/koolbot/issues/457)) ([#473](https://github.com/lonix/koolbot/issues/473)) ([96bdb77](https://github.com/lonix/koolbot/commit/96bdb772d8b0396d368af679155810abe9ccfb87))


### 📚 Documentation

* delete stale root markdown files (closes [#390](https://github.com/lonix/koolbot/issues/390)) ([#425](https://github.com/lonix/koolbot/issues/425)) ([9f494fe](https://github.com/lonix/koolbot/commit/9f494fef50602417f635976818ee772fad7d4dfc))
* document role-aware /config and /me user self-service surface (closes [#480](https://github.com/lonix/koolbot/issues/480)) ([#502](https://github.com/lonix/koolbot/issues/502)) ([4ccfa60](https://github.com/lonix/koolbot/commit/4ccfa60ca59131b0dd1217e53895f1e57caab04c))
* rework for v1.0 Web UI surface ([#387](https://github.com/lonix/koolbot/issues/387)) ([#416](https://github.com/lonix/koolbot/issues/416)) ([7b936bd](https://github.com/lonix/koolbot/commit/7b936bd6a8fff119346e53f0ae4bfe8e2553e359))


### 🔧 Maintenance

* delete dead code and abandoned helper scripts ([#424](https://github.com/lonix/koolbot/issues/424)) ([6a86976](https://github.com/lonix/koolbot/commit/6a869760f6448e4bbe8658a3e6f317c6614aed0f)), closes [#391](https://github.com/lonix/koolbot/issues/391)
* pre-1.0 code-quality sweep over src/ ([#392](https://github.com/lonix/koolbot/issues/392)) ([#531](https://github.com/lonix/koolbot/issues/531)) ([d354172](https://github.com/lonix/koolbot/commit/d354172d687464d89947a5384718714795e53581))

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
