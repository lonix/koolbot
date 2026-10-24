# Changelog

## [2.1.0](https://github.com/lonix/koolbot/compare/v2.0.1...v2.1.0) (2026-10-24)


### 🚀 Features

* **access:** Event host and Moderator scopes from role-group capabilities ([#1335](https://github.com/lonix/koolbot/issues/1335)) ([a466a39](https://github.com/lonix/koolbot/commit/a466a39cd582ac388b04a7b1e6a5385638e1fba5))
* **adoption:** adopt existing native events as KoolBot events ([#1177](https://github.com/lonix/koolbot/issues/1177)) ([4a0f08b](https://github.com/lonix/koolbot/commit/4a0f08b38441bcd12fac7edfd86cce02201e7ca2))
* **adoption:** bot replacement report for detected known bots ([#1115](https://github.com/lonix/koolbot/issues/1115)) ([f6d3967](https://github.com/lonix/koolbot/commit/f6d3967e2c0f76a8afad89a33e7e117f16a6519d))
* **adoption:** check live state before restoring a snapshot ([#1139](https://github.com/lonix/koolbot/issues/1139)) ([4295f0f](https://github.com/lonix/koolbot/commit/4295f0f729dd1780c6c73476463bb9884c7e6829))
* **adoption:** claim categories and channels ([#1096](https://github.com/lonix/koolbot/issues/1096)) ([e2a24fc](https://github.com/lonix/koolbot/commit/e2a24fcb48ad559ec7784e6e6dfa6f5aea3e7126))
* **adoption:** cleanup plan for the leftovers of a removed bot ([#1456](https://github.com/lonix/koolbot/issues/1456)) ([9beda94](https://github.com/lonix/koolbot/commit/9beda9420c989031ac4d4280edc0265efb3be12d))
* **adoption:** keep leaderboard, reaction and birthday roles out of role groups ([#1137](https://github.com/lonix/koolbot/issues/1137)) ([2f0286c](https://github.com/lonix/koolbot/commit/2f0286ca1f853d74948619b545077eaddbdfd1d1))
* **adoption:** keep role groups in sync with Discord ([#1098](https://github.com/lonix/koolbot/issues/1098)) ([14a30de](https://github.com/lonix/koolbot/commit/14a30de7fba297c9a9be6a23251794872bbaef01))
* **adoption:** optional rules / TOS acceptance role ([#1100](https://github.com/lonix/koolbot/issues/1100)) ([c01bc63](https://github.com/lonix/koolbot/commit/c01bc63f7c67715123ea32830c392b3f25db328b))
* **adoption:** plan / apply / snapshot / rollback engine for server permission changes ([#1073](https://github.com/lonix/koolbot/issues/1073)) ([f9ccecb](https://github.com/lonix/koolbot/commit/f9ccecb7e992dada24ec2c98ccf9f29cca33771a))
* **adoption:** register role-gated categories as game roles, suggest feeds and gate stage speakers ([#1173](https://github.com/lonix/koolbot/issues/1173)) ([f1dd828](https://github.com/lonix/koolbot/commit/f1dd8280f9f26c59d6546dde39d551118f7e7c24))
* **adoption:** show reaction roles as used in the scan, offer groups in more pickers, add webhooks to the scan ([#1170](https://github.com/lonix/koolbot/issues/1170)) ([9c2ca18](https://github.com/lonix/koolbot/commit/9c2ca183b7d1d9f91b81d05b0c6028f677a1159b))
* **adoption:** use role groups in command permissions, quotes and role pickers ([#1118](https://github.com/lonix/koolbot/issues/1118)) ([fd9f032](https://github.com/lonix/koolbot/commit/fd9f0320c4a17efc7a08dedd4f116a70895b601e))
* **adoption:** wizard entry point, adoption history with restore, docs and end-to-end test ([#1129](https://github.com/lonix/koolbot/issues/1129)) ([122d1f2](https://github.com/lonix/koolbot/commit/122d1f24407a0dcd048432fef6d2828e11de5dd7))
* **commands:** choose DM or ephemeral delivery for /me and /config links ([#1080](https://github.com/lonix/koolbot/issues/1080)) ([45a8fad](https://github.com/lonix/koolbot/commit/45a8fade3b6a29ba7e0c593192535f5910952351)), closes [#1067](https://github.com/lonix/koolbot/issues/1067)
* **discord:** footers, Discord timestamps and real mentions ([#1348](https://github.com/lonix/koolbot/issues/1348)) ([3cb3e79](https://github.com/lonix/koolbot/commit/3cb3e79c208db94e6c0ff68da815f6e9f13958c7))
* **discord:** one embed colour helper from the design tokens ([#1339](https://github.com/lonix/koolbot/issues/1339)) ([1d0dafc](https://github.com/lonix/koolbot/commit/1d0dafc787ce21861bc09d59873d349f09ad45de))
* **discord:** plain-English copy for the help embed and the notices header ([#1356](https://github.com/lonix/koolbot/issues/1356)) ([83a9210](https://github.com/lonix/koolbot/commit/83a9210d3a202a8f83713e73840fa8c0566906e0))
* **events:** a setting for how many open events a host may have ([#1447](https://github.com/lonix/koolbot/issues/1447)) ([d2ba7c7](https://github.com/lonix/koolbot/commit/d2ba7c723759ab8e3187ceb751997c9668c35c48))
* **events:** assign members to groups ([#1215](https://github.com/lonix/koolbot/issues/1215)) ([73c9b31](https://github.com/lonix/koolbot/commit/73c9b3165e6255a2d02a5205472dcacf8772fef5))
* **events:** Captains lobby switch instead of a leads group row ([#1261](https://github.com/lonix/koolbot/issues/1261)) ([012134f](https://github.com/lonix/koolbot/commit/012134fd6a41569e4afa20531a90339cd1c24645))
* **events:** Captains lobby tick in the group preset editor ([#1282](https://github.com/lonix/koolbot/issues/1282)) ([42bb083](https://github.com/lonix/koolbot/commit/42bb08363988f9fb2ac8e8bf4c581f39a25f821e))
* **events:** cover image on the host's edit page ([#1439](https://github.com/lonix/koolbot/issues/1439)) ([d08941b](https://github.com/lonix/koolbot/commit/d08941bb6bfeabd4148f63e65b016104911634ac))
* **events:** create, limit and clean up group voice channels ([#1213](https://github.com/lonix/koolbot/issues/1213)) ([761b8e6](https://github.com/lonix/koolbot/commit/761b8e6a1f955b071e8a695ca33380098576547c))
* **events:** edit an occurrence or the rest of a recurring series ([#1418](https://github.com/lonix/koolbot/issues/1418)) ([bda94da](https://github.com/lonix/koolbot/commit/bda94da3155a3da66e3d14500bf130e03593c055))
* **events:** edit an upcoming event from the Web UI ([#1347](https://github.com/lonix/koolbot/issues/1347)) ([f507a05](https://github.com/lonix/koolbot/commit/f507a05c2afb3d0b4a37610cc509a98b16993e61))
* **events:** end event now with one shared teardown ([#1223](https://github.com/lonix/koolbot/issues/1223)) ([1be48cb](https://github.com/lonix/koolbot/commit/1be48cbe0807f33387c8d252a2da320faffb81c6))
* **events:** Event presets in the admin sidebar ([#1453](https://github.com/lonix/koolbot/issues/1453)) ([1c8255a](https://github.com/lonix/koolbot/commit/1c8255ad478c4b9ae098b0c31c59bbe7d1f6d60f))
* **events:** group leaders and pull leaders only ([#1222](https://github.com/lonix/koolbot/issues/1222)) ([c14ac83](https://github.com/lonix/koolbot/commit/c14ac8326a24dd237c3b961272ad71e2e80be980))
* **events:** group setup form folds to one line, presets first, generate rows, emoji picker ([#1407](https://github.com/lonix/koolbot/issues/1407)) ([4900d3b](https://github.com/lonix/koolbot/commit/4900d3ba05d0300180b1963fd8f9f3e27a082c9e))
* **events:** groups model, built-in presets and group setup on the event form ([#1203](https://github.com/lonix/koolbot/issues/1203)) ([d09672b](https://github.com/lonix/koolbot/commit/d09672b70bef332d3e93d40b345cc5a6a344a188))
* **events:** header row and derived tags in the preset editors ([#1458](https://github.com/lonix/koolbot/issues/1458)) ([603864e](https://github.com/lonix/koolbot/commit/603864e7864117d79bb35bd9ae503b38936be76e))
* **events:** host moves: send to groups, return to main, move individual ([#1221](https://github.com/lonix/koolbot/issues/1221)) ([bd02677](https://github.com/lonix/koolbot/commit/bd026771e272616eb9b915be7bfe36a8481192d0))
* **events:** host panel for event creators ([#1209](https://github.com/lonix/koolbot/issues/1209)) ([ab2999c](https://github.com/lonix/koolbot/commit/ab2999c2f34df7182e3ea633a832afe758e3cd4e))
* **events:** host-panel Settings section and live-edit core ([#1245](https://github.com/lonix/koolbot/issues/1245)) ([90245b7](https://github.com/lonix/koolbot/commit/90245b713579727874af90a526d6b6cfb60d2911))
* **events:** impromptu events (When: Now) and event creation for hosts ([#1409](https://github.com/lonix/koolbot/issues/1409)) ([61937ee](https://github.com/lonix/koolbot/commit/61937ee733525b13684c49bd32ae562a2129ef98))
* **events:** leader customiser in Discord ([#1230](https://github.com/lonix/koolbot/issues/1230)) ([3e6acb8](https://github.com/lonix/koolbot/commit/3e6acb863973cb60441f531c567ffef9368b0719))
* **events:** leads-only command channel for group leaders ([#1224](https://github.com/lonix/koolbot/issues/1224)) ([9dc9e21](https://github.com/lonix/koolbot/commit/9dc9e21c89ab0250fce45d5520afd463a8ab7d33))
* **events:** let the host change a team's marker and tag in a running event ([#1465](https://github.com/lonix/koolbot/issues/1465)) ([441d8e4](https://github.com/lonix/koolbot/commit/441d8e4670c76e345ac50056661f2432874e6be6))
* **events:** link the native Discord event to the voice room once it exists ([#1431](https://github.com/lonix/koolbot/issues/1431)) ([7c7717a](https://github.com/lonix/koolbot/commit/7c7717abecda7d7a63777b8909e3bc308f047eb5))
* **events:** live edit of group names, sizes and preset on a running event ([#1248](https://github.com/lonix/koolbot/issues/1248)) ([c2badf1](https://github.com/lonix/koolbot/commit/c2badf1123887465b7fde276844d0d26a7224272))
* **events:** live edit of leaders, leader customisation and clan tags on a running event ([#1247](https://github.com/lonix/koolbot/issues/1247)) ([411a363](https://github.com/lonix/koolbot/commit/411a363d1a2c0682f5b2e4b76a07d3272ae50857))
* **events:** live edit that adds and removes groups of a running event ([#1249](https://github.com/lonix/koolbot/issues/1249)) ([84bf04d](https://github.com/lonix/koolbot/commit/84bf04d418deaad10e8570742913340ecc165f41))
* **events:** mirror KoolBot events to Discord scheduled events ([#1117](https://github.com/lonix/koolbot/issues/1117)) ([258f25d](https://github.com/lonix/koolbot/commit/258f25da888777b831246ea060dae8aea9542912))
* **events:** name the built-in group presets by team count ([#1338](https://github.com/lonix/koolbot/issues/1338)) ([835efbf](https://github.com/lonix/koolbot/commit/835efbfdd916352540db752013babe603194c7fb))
* **events:** optional cover image mirrored to the native Discord event ([#1198](https://github.com/lonix/koolbot/issues/1198)) ([b012d15](https://github.com/lonix/koolbot/commit/b012d154e40014590e1b788a21e1d86f9738b9d4))
* **events:** order group voice channels as configured ([#1220](https://github.com/lonix/koolbot/issues/1220)) ([1d62c02](https://github.com/lonix/koolbot/commit/1d62c02e01fb2c1e859112ea38b2884c87e4533a))
* **events:** personal group presets for hosts, with admin publish to the server library ([#1262](https://github.com/lonix/koolbot/issues/1262)) ([6d22bfc](https://github.com/lonix/koolbot/commit/6d22bfc4360fd1bc5972d66eb4dba8f76c112384))
* **events:** prefill the group setup from the host's last event ([#1462](https://github.com/lonix/koolbot/issues/1462)) ([bdbaba9](https://github.com/lonix/koolbot/commit/bdbaba901666c0e2547ec8ff3d54812ec6bbef07))
* **events:** recurring events keep the host's group setup ([#1283](https://github.com/lonix/koolbot/issues/1283)) ([8cf4638](https://github.com/lonix/koolbot/commit/8cf4638e0772d2c7356c9cb66f5fd99fea320d9d))
* **events:** server-wide group preset library with on/off toggles ([#1212](https://github.com/lonix/koolbot/issues/1212)) ([f1cd489](https://github.com/lonix/koolbot/commit/f1cd489adec5d5534e2437dc9a79445aeac5f2c4))
* **events:** support recurring events (weekly/biweekly/monthly) ([#1082](https://github.com/lonix/koolbot/issues/1082)) ([080e30c](https://github.com/lonix/koolbot/commit/080e30c0218b1cec88095ba2a94538e286c03b31))
* **events:** switch groups on or off while an event is running ([#1260](https://github.com/lonix/koolbot/issues/1260)) ([10e9b62](https://github.com/lonix/koolbot/commit/10e9b62d85f54048f065b617b0f274ec63042bf7))
* **events:** temporary clan tags with guaranteed nickname restore ([#1228](https://github.com/lonix/koolbot/issues/1228)) ([ed32c02](https://github.com/lonix/koolbot/commit/ed32c026fbff8f0d5943fc0ed433ba56336da4f8))
* **events:** use Discord native scheduled events only ([#1176](https://github.com/lonix/koolbot/issues/1176)) ([61971cd](https://github.com/lonix/koolbot/commit/61971cd6742e740a355fc8ee5d008c538e9b7dbd))
* **moderation:** anti-raid join-rate and new-account gate ([#1111](https://github.com/lonix/koolbot/issues/1111)) ([9394d3e](https://github.com/lonix/koolbot/commit/9394d3e621dd02c2702274c4c2e79d2a8f6f36cf))
* **moderation:** case lifecycle with review dates and outcomes ([#1072](https://github.com/lonix/koolbot/issues/1072)) ([73ccf1a](https://github.com/lonix/koolbot/commit/73ccf1a1d47b27046146b9eb7bc001b228b95eb6))
* **notices:** list only member-facing features and make shutdown mid-refresh safe ([#1136](https://github.com/lonix/koolbot/issues/1136)) ([9cc9824](https://github.com/lonix/koolbot/commit/9cc982438f1ea7c807471550fe28cdb1275fccb0))
* **reaction-roles:** generate grouped roles from presets or custom lists ([#1101](https://github.com/lonix/koolbot/issues/1101)) ([31f4cc8](https://github.com/lonix/koolbot/commit/31f4cc8210048beb0fd27c1199529d84b8bca16b))
* **reaction-roles:** remember each picker's channel so a changed picker channel keeps working ([#1219](https://github.com/lonix/koolbot/issues/1219)) ([cb56e41](https://github.com/lonix/koolbot/commit/cb56e41e47386e926a3a023a7f946441e850d593))
* **rewind:** summarise voice time by kind of room instead of room names ([#1432](https://github.com/lonix/koolbot/issues/1432)) ([8edf8f7](https://github.com/lonix/koolbot/commit/8edf8f7e45852a4d1f89a7ac1c0c707357d8f9f4))
* **tickets:** member support tickets with private channels, /ticket command and admin page ([#1071](https://github.com/lonix/koolbot/issues/1071)) ([655ebae](https://github.com/lonix/koolbot/commit/655ebaecee3b322cfe5a882e17d10947e4505fec))
* **voice:** grant room owners the native Set Voice Channel Status permission ([#1110](https://github.com/lonix/koolbot/issues/1110)) ([60eac33](https://github.com/lonix/koolbot/commit/60eac33a9dbed2f6486c202fd82c2932b756209a))
* **voice:** keep names of finished public rooms in voicestats ([#1183](https://github.com/lonix/koolbot/issues/1183)) ([521cd0f](https://github.com/lonix/koolbot/commit/521cd0fb893f218652fd5be697f3d0e4b58641c5))
* **web-ui:** /me only shows features that are switched on ([#1374](https://github.com/lonix/koolbot/issues/1374)) ([2a02930](https://github.com/lonix/koolbot/commit/2a029308e587c5a4be40a69972471c95dac3ce26))
* **web-ui:** add the Mod log and Command audit to the moderator sidebar ([#1359](https://github.com/lonix/koolbot/issues/1359)) ([80db2d8](https://github.com/lonix/koolbot/commit/80db2d8926c5d423a964c85d157c0fcfd60cd657))
* **web-ui:** app shell with top bar, scope badges and a sidebar per scope ([#1349](https://github.com/lonix/koolbot/issues/1349)) ([a8cd277](https://github.com/lonix/koolbot/commit/a8cd27778044c8bb67f8d9f464c5195f9da2b9fe))
* **web-ui:** bot permissions as a permission matrix with the fix summary first ([#1367](https://github.com/lonix/koolbot/issues/1367)) ([5f62676](https://github.com/lonix/koolbot/commit/5f62676237fe236d6f6951a921861c66f42d75ab))
* **web-ui:** bounded whole-number settings and read-only bot-managed message ids ([#1429](https://github.com/lonix/koolbot/issues/1429)) ([73f2f29](https://github.com/lonix/koolbot/commit/73f2f2907933733d6fc5dfdc89cd3c9ef8c25768))
* **web-ui:** category and channel manager for text and voice channels ([#1172](https://github.com/lonix/koolbot/issues/1172)) ([0eba996](https://github.com/lonix/koolbot/commit/0eba99697b522c08d57b5d2f6b726177cf18b1cb))
* **web-ui:** check the bot's permissions in more posting channels ([#1459](https://github.com/lonix/koolbot/issues/1459)) ([e999eb9](https://github.com/lonix/koolbot/commit/e999eb904622e7962b37d12132aab894abd71e96))
* **web-ui:** check the bot's permissions in the channels its features post to ([#1454](https://github.com/lonix/koolbot/issues/1454)) ([6c38679](https://github.com/lonix/koolbot/commit/6c38679d6a85aed2845ced7e6d8bf7dfc10ae3ab))
* **web-ui:** confirm turning groups off and removing groups in a dialog ([#1363](https://github.com/lonix/koolbot/issues/1363)) ([b2305ad](https://github.com/lonix/koolbot/commit/b2305ad23eef897d93e6762c595e80254b3df0e2))
* **web-ui:** Dashboard with state tiles, Needs you, this week in voice and feature links ([#1416](https://github.com/lonix/koolbot/issues/1416)) ([66c7e8f](https://github.com/lonix/koolbot/commit/66c7e8f256ba9676f9278f048df6e81b5553de99))
* **web-ui:** Discord channel and role labels on the remaining pages ([#1468](https://github.com/lonix/koolbot/issues/1468)) ([948ee0e](https://github.com/lonix/koolbot/commit/948ee0e74a22530131f2f9174deafc5819dc8693))
* **web-ui:** duration presets for the remaining minute, hour, day and second settings ([#1451](https://github.com/lonix/koolbot/issues/1451)) ([c745ee2](https://github.com/lonix/koolbot/commit/c745ee236eff9732b0201b6918eb8ce7aee76716))
* **web-ui:** feature pages show the usable part first, settings folded below ([#1373](https://github.com/lonix/koolbot/issues/1373)) ([8c06d96](https://github.com/lonix/koolbot/commit/8c06d96df1a3dce105c2fc045e7d0eeeb368dd1a))
* **web-ui:** host panel as a team board with a toolbar ([#1440](https://github.com/lonix/koolbot/issues/1440)) ([6548d8b](https://github.com/lonix/koolbot/commit/6548d8bb3ee8ee11a86b2071e0f91490126838f3))
* **web-ui:** keep Server scan problems on the Dashboard for longer ([#1423](https://github.com/lonix/koolbot/issues/1423)) ([2e39749](https://github.com/lonix/koolbot/commit/2e397490990b8f5acb1c73b10bbdc3f02ccf6335)), closes [#1415](https://github.com/lonix/koolbot/issues/1415)
* **web-ui:** label channels, categories and roles the way Discord does ([#1410](https://github.com/lonix/koolbot/issues/1410)) ([b8e8702](https://github.com/lonix/koolbot/commit/b8e8702c2939dd427f29c58688858d6b6edd7590))
* **web-ui:** list every Discord permission on the bot permissions page ([#1414](https://github.com/lonix/koolbot/issues/1414)) ([71008ac](https://github.com/lonix/koolbot/commit/71008acfa35b0e6ee4e593da28cff34e3e806c54))
* **web-ui:** mod log for moderators at /me/moderation ([#1350](https://github.com/lonix/koolbot/issues/1350)) ([cd13437](https://github.com/lonix/koolbot/commit/cd1343796f783632b69fdbf6a06d026b03aae090))
* **web-ui:** native confirmation dialogs for destructive admin actions ([#1345](https://github.com/lonix/koolbot/issues/1345)) ([d9d429d](https://github.com/lonix/koolbot/commit/d9d429d46eb391208ca4b5fb4d564f16cb71581c))
* **web-ui:** one save bar per settings form (split from [#1318](https://github.com/lonix/koolbot/issues/1318)) ([#1346](https://github.com/lonix/koolbot/issues/1346)) ([a059f20](https://github.com/lonix/koolbot/commit/a059f208bdf9df454de73b3239c5f070d1ab888c))
* **web-ui:** one stylesheet from the design tokens, replacing the inline STYLE colours ([#1328](https://github.com/lonix/koolbot/issues/1328)) ([75cf43c](https://github.com/lonix/koolbot/commit/75cf43cf579ab95c6efadde8090ea261b47997b3))
* **web-ui:** pick the welcome roles message from the bot's reaction-role messages ([#1452](https://github.com/lonix/koolbot/issues/1452)) ([0d6c92c](https://github.com/lonix/koolbot/commit/0d6c92caf54ec901bd9121f60cc209c941bedc10))
* **web-ui:** re-post action for bot-managed messages, hide leaderboard tiers from All settings ([#1434](https://github.com/lonix/koolbot/issues/1434)) ([b73a796](https://github.com/lonix/koolbot/commit/b73a796fbd8f0fca4d4b6fa67f0167a9954d4d40))
* **web-ui:** reorganise the admin nav by task; rename Permissions to "Command permissions" ([#1370](https://github.com/lonix/koolbot/issues/1370)) ([eb9cf4e](https://github.com/lonix/koolbot/commit/eb9cf4e04d84be6041b15307046192b03bde2ee0))
* **web-ui:** searchable picker for single channel, category and role settings ([#1455](https://github.com/lonix/koolbot/issues/1455)) ([0b3369e](https://github.com/lonix/koolbot/commit/0b3369e8b89646f1c37c213ac80b01cff0d5ea6a))
* **web-ui:** Server scan Channels tab as the Discord tree with filters, per-row overwrites and Claim ([#1413](https://github.com/lonix/koolbot/issues/1413)) ([c6f21ba](https://github.com/lonix/koolbot/commit/c6f21ba05282d32097dacba782c096b5eb892c61))
* **web-ui:** Server scan opens on the verdict, with tabs for the inventories ([#1368](https://github.com/lonix/koolbot/issues/1368)) ([3763b09](https://github.com/lonix/koolbot/commit/3763b09cf4451b99bc60c208944ead7f343933a6))
* **web-ui:** shared icon helper with the design system's icons ([#1411](https://github.com/lonix/koolbot/issues/1411)) ([6a4f361](https://github.com/lonix/koolbot/commit/6a4f3612baa1eb7b896b4fbdf61de8a45c44faf8))
* **web-ui:** show a missing Discord permission next to the feature that needs it ([#1467](https://github.com/lonix/koolbot/issues/1467)) ([5926677](https://github.com/lonix/koolbot/commit/5926677e9f82480bb41ec6240c1465023ff2f3b6))
* **web-ui:** show deleted voice rooms by their stored name in the command audit ([#1445](https://github.com/lonix/koolbot/issues/1445)) ([e15a126](https://github.com/lonix/koolbot/commit/e15a126a15c0df2249c6f8b5306b1fd7228eb35c))
* **web-ui:** show which Discord permissions the bot is missing ([#1259](https://github.com/lonix/koolbot/issues/1259)) ([c94e0d9](https://github.com/lonix/koolbot/commit/c94e0d9c91c3127e33b99325617440efc81ed4dc))
* **web-ui:** steppers and duration presets for small-range number settings ([#1446](https://github.com/lonix/koolbot/issues/1446)) ([6aab319](https://github.com/lonix/koolbot/commit/6aab3196d85173073a0aeb46ed691f835130a7ef))
* **web-ui:** switches, segmented controls and nested setting rows ([#1340](https://github.com/lonix/koolbot/issues/1340)) ([c1b5f74](https://github.com/lonix/koolbot/commit/c1b5f74e19c7c950584a4b316dceb722bed68143))
* **web-ui:** timezone select, colour input and emoji picker for free-text settings ([#1438](https://github.com/lonix/koolbot/issues/1438)) ([45b29de](https://github.com/lonix/koolbot/commit/45b29de9806364c7980a755f94b304f830a0e74d))
* **web-ui:** use the searchable timezone select on /me/timezone ([#1443](https://github.com/lonix/koolbot/issues/1443)) ([402b0e8](https://github.com/lonix/koolbot/commit/402b0e87e6f2c7e6e5c7764472fa309590f4ba22))
* **web-ui:** Your events for event hosts (list, Start now, New event) ([#1425](https://github.com/lonix/koolbot/issues/1425)) ([4ae557a](https://github.com/lonix/koolbot/commit/4ae557aaebeb65b04061ad4d6edcaa11d68c01dd))
* **welcome:** greet new members in a configured channel ([#1084](https://github.com/lonix/koolbot/issues/1084)) ([a6a808e](https://github.com/lonix/koolbot/commit/a6a808e67a3084b2270f8cfe8b8759d31f8ce484))
* **wizard:** Access step mapping Discord roles to Admins, Moderators and Event hosts ([#1371](https://github.com/lonix/koolbot/issues/1371)) ([b111a9b](https://github.com/lonix/koolbot/commit/b111a9b215f04f65ce85bdece8d72f3566799a56))
* **wizard:** create the Event host role from the Access step ([#1417](https://github.com/lonix/koolbot/issues/1417)) ([0c76185](https://github.com/lonix/koolbot/commit/0c76185bb29290272a69d37fa8d17fb0a28cc927))


### 🐛 Bug Fixes

* add per-member limits and refuse dangerous roles in reaction roles ([#1159](https://github.com/lonix/koolbot/issues/1159)) ([bc1d830](https://github.com/lonix/koolbot/commit/bc1d8302c6f376f0383061bfc5987f320a73d1f4))
* **adoption:** classify forum and media channels the same in the scan, rules plan and live read ([#1256](https://github.com/lonix/koolbot/issues/1256)) ([acf0464](https://github.com/lonix/koolbot/commit/acf0464cd195d37a30661a17660b8e64fa62f2e9))
* **adoption:** rate limits, reviewed role deletion and a destructive section in the preview ([#1202](https://github.com/lonix/koolbot/issues/1202)) ([92c69c7](https://github.com/lonix/koolbot/commit/92c69c7c2204c5078fc5f1175f5056b2ddafe535))
* **adoption:** revalidate before deleting a group's role ([#1107](https://github.com/lonix/koolbot/issues/1107)) ([3b87051](https://github.com/lonix/koolbot/commit/3b8705199e7bdcc2e317d22b86a4033bf2a61408))
* **adopt:** point the GuildMembers intent note at GUILD_MEMBERS_INTENT ([#1126](https://github.com/lonix/koolbot/issues/1126)) ([06273eb](https://github.com/lonix/koolbot/commit/06273eb1a5140a74d4073d011c23a95fd428a1f9))
* **ci:** do not fail Release Please when it touched no pull request ([#1461](https://github.com/lonix/koolbot/issues/1461)) ([e1d6718](https://github.com/lonix/koolbot/commit/e1d6718047e8256527ec3c3bfd55730f8b9450ad))
* **commands:** register guild commands with one overwrite and log REST rate limits ([#1312](https://github.com/lonix/koolbot/issues/1312)) ([5974436](https://github.com/lonix/koolbot/commit/5974436c05f256136731e3ab4421279dd00a1ea6))
* **commands:** skip the command bulk-overwrite when unchanged and share one REST instance ([#1337](https://github.com/lonix/koolbot/issues/1337)) ([c62c275](https://github.com/lonix/koolbot/commit/c62c275eaf33d6b1ace301c20dde7bd4987e1657))
* **config:** let a YAML import and adoption plan keep a stored picker value that fails the new check ([#1450](https://github.com/lonix/koolbot/issues/1450)) ([ee86950](https://github.com/lonix/koolbot/commit/ee86950ccceeca9f7b03396e17aa09a5b702f269))
* **config:** take setting descriptions from the schema, not the stored copy ([#1311](https://github.com/lonix/koolbot/issues/1311)) ([18c232b](https://github.com/lonix/koolbot/commit/18c232b7387471cc1446e21debdd7972f7daad7e)), closes [#1302](https://github.com/lonix/koolbot/issues/1302)
* **database:** remove duplicate AdoptionSnapshot guildId index ([#1104](https://github.com/lonix/koolbot/issues/1104)) ([dadaec4](https://github.com/lonix/koolbot/commit/dadaec4482c3bf01852fe5d11d9878a4b2d39ab5)), closes [#1102](https://github.com/lonix/koolbot/issues/1102)
* **deps:** override katex to 0.18.x (prototype pollution, Dependabot [#110](https://github.com/lonix/koolbot/issues/110)) ([#1258](https://github.com/lonix/koolbot/issues/1258)) ([7e65c62](https://github.com/lonix/koolbot/commit/7e65c62dd956ab632290f1690860a332612fb918)), closes [#1227](https://github.com/lonix/koolbot/issues/1227)
* **deps:** override smol-toml to ^1.9.1 (quadratic-time parse) ([#1257](https://github.com/lonix/koolbot/issues/1257)) ([d30c10a](https://github.com/lonix/koolbot/commit/d30c10ae57b0457faea5e134114e1002b58e716f)), closes [#1226](https://github.com/lonix/koolbot/issues/1226)
* **deps:** raise brace-expansion past the quadratic-time {a},b} advisory ([#1255](https://github.com/lonix/koolbot/issues/1255)) ([5193c4d](https://github.com/lonix/koolbot/commit/5193c4ddf175a333397dc5e1c6ec6e4494da311d)), closes [#1225](https://github.com/lonix/koolbot/issues/1225)
* **deps:** upgrade js-yaml to 5.x and use namespace import in poll-service ([#1075](https://github.com/lonix/koolbot/issues/1075)) ([3e3be2c](https://github.com/lonix/koolbot/commit/3e3be2c9b0a6d9a70be2594f4fa993af4ac44bf8))
* **events:** a host end always pulls everyone back to the main room ([#1444](https://github.com/lonix/koolbot/issues/1444)) ([dfa8615](https://github.com/lonix/koolbot/commit/dfa8615bb95fcfdaceb579021c28dcd848c7eb4b))
* **events:** custom groups on switch-on, clear member data at end, harden switch-off ([#1271](https://github.com/lonix/koolbot/issues/1271)) ([bdb7b17](https://github.com/lonix/koolbot/commit/bdb7b176004bfd7f29ecfffd740c72ea79261fe0))
* **events:** guard group name edits by group key ([#1268](https://github.com/lonix/koolbot/issues/1268)) ([ff37e58](https://github.com/lonix/koolbot/commit/ff37e58e688b0f6a746039d0d2696d2201096b3f))
* **events:** refuse an event edit saved under a different state than it was rendered in ([#1361](https://github.com/lonix/koolbot/issues/1361)) ([58c4028](https://github.com/lonix/koolbot/commit/58c40280eea3d4c310500200291da7d7d37b9322))
* **events:** restore a rejected draft's full-cap rows when a lobby was remembered ([#1463](https://github.com/lonix/koolbot/issues/1463)) ([afde4ed](https://github.com/lonix/koolbot/commit/afde4edde0f45cf6086d2f8e46b6dd902686e5aa))
* **events:** set updatePipeline on aggregation-pipeline updates ([#1105](https://github.com/lonix/koolbot/issues/1105)) ([c606cec](https://github.com/lonix/koolbot/commit/c606cecf8faf0f1eecb307499d372048902c1d41)), closes [#1103](https://github.com/lonix/koolbot/issues/1103)
* **events:** the lock starts off in every occurrence of a series ([#1285](https://github.com/lonix/koolbot/issues/1285)) ([8547975](https://github.com/lonix/koolbot/commit/8547975d20f7b890befc5df6d64303637ac874cc))
* limit lobby room churn, purge dead web sessions and audit component interactions ([#1168](https://github.com/lonix/koolbot/issues/1168)) ([edd84c4](https://github.com/lonix/koolbot/commit/edd84c4779c6e8322adc73f56db742014204da42))
* **notices:** list Name History once and refresh the features notice on settings save ([#1127](https://github.com/lonix/koolbot/issues/1127)) ([ead78c6](https://github.com/lonix/koolbot/commit/ead78c6404a383c17da49c8505fcf27500a5078c))
* ping nobody by default and escape member names in message text ([#1169](https://github.com/lonix/koolbot/issues/1169)) ([9fc3632](https://github.com/lonix/koolbot/commit/9fc36329467e31a24aea824041c6c97d6c73120b))
* **quotes:** refresh the stored quote header so existing servers get the current copy and footer ([#1362](https://github.com/lonix/koolbot/issues/1362)) ([0f167f4](https://github.com/lonix/koolbot/commit/0f167f40fdb56487c8160fec3ef4e1cb42f4fd6f))
* **reactionroles:** keep mappings when no picker is found in the configured channel ([#1201](https://github.com/lonix/koolbot/issues/1201)) ([8b4e6dd](https://github.com/lonix/koolbot/commit/8b4e6dd9262337ac4806961c2eca47cc795106ad))
* **roles:** refuse group-backed roles at grant time for birthday, leaderboard, rules and raid ([#1419](https://github.com/lonix/koolbot/issues/1419)) ([d3403f6](https://github.com/lonix/koolbot/commit/d3403f6915d8b0fca51ac55a13b02f87b5ba1223))
* scope the bot to GUILD_ID and default to safe allowed mentions ([#1161](https://github.com/lonix/koolbot/issues/1161)) ([b91d84f](https://github.com/lonix/koolbot/commit/b91d84f3bda9e31c857556768ac7a28c11445050))
* **security:** record names and sessions only for the configured guild ([#1182](https://github.com/lonix/koolbot/issues/1182)) ([d2b8a9b](https://github.com/lonix/koolbot/commit/d2b8a9bad9e7bff57e7d8ec38bdba730c90ef1a7))
* **security:** refuse dangerous roles for leaderboard tiers and the birthday role ([#1186](https://github.com/lonix/koolbot/issues/1186)) ([8f94159](https://github.com/lonix/koolbot/commit/8f9415901c5b48d01f1f8b153232d07439296b21))
* **shutdown:** keep slash commands registered on graceful shutdown ([#1313](https://github.com/lonix/koolbot/issues/1313)) ([7345777](https://github.com/lonix/koolbot/commit/7345777748c2724262b79fee6594937f56419ee9)), closes [#1294](https://github.com/lonix/koolbot/issues/1294)
* stop logging sign-in links and trim member-facing error detail ([#1157](https://github.com/lonix/koolbot/issues/1157)) ([7d1aecd](https://github.com/lonix/koolbot/commit/7d1aecd982359c856c99255be58b1f7cfcafaeec))
* **voice:** authorise room controls against live ownership and stop name-based channel spoofing ([#1160](https://github.com/lonix/koolbot/issues/1160)) ([f1b4aea](https://github.com/lonix/koolbot/commit/f1b4aea1550cdce6f4eb5d283f6dccf917c0215c))
* **voice:** keep quotes in lobby name during health check ([#1093](https://github.com/lonix/koolbot/issues/1093)) ([a8b9f09](https://github.com/lonix/koolbot/commit/a8b9f0938d79d0c97dd3d68d03db18a3beb9a72f))
* **voice:** only clean up voice channels KoolBot created, behind a managed-only toggle ([#1078](https://github.com/lonix/koolbot/issues/1078)) ([eaca3a8](https://github.com/lonix/koolbot/commit/eaca3a8b81fbac55147a783b61b7dea84be4b828))
* **voice:** persist waiting-room link across restarts ([#1092](https://github.com/lonix/koolbot/issues/1092)) ([6d5d51e](https://github.com/lonix/koolbot/commit/6d5d51e479ff3433f2125dce36800c6b4cd2561d))
* **voice:** retry managed-channel record when the write fails ([#1091](https://github.com/lonix/koolbot/issues/1091)) ([dbe886b](https://github.com/lonix/koolbot/commit/dbe886b5dd4051753f7dba27ec7b6ca9aa1c65e9)), closes [#1088](https://github.com/lonix/koolbot/issues/1088)
* **web-ui:** add security headers and bind CSRF tokens to the session ([#1163](https://github.com/lonix/koolbot/issues/1163)) ([d53dcd6](https://github.com/lonix/koolbot/commit/d53dcd69f92da48de353b10dfb4926c9eb097bf2))
* **web-ui:** bound /me audit data and revalidate member sessions ([#1158](https://github.com/lonix/koolbot/issues/1158)) ([b1cfaba](https://github.com/lonix/koolbot/commit/b1cfabab6a5977c053e5e36819e141acab8dcbf8))
* **web-ui:** hide the member Privacy section when the feature is disabled ([#1077](https://github.com/lonix/koolbot/issues/1077)) ([44557a6](https://github.com/lonix/koolbot/commit/44557a6e37ba06e060ab8439f0e4875d51991e78))
* **web-ui:** keep channel name prefix and suffix free text, cap at 32 characters ([#1449](https://github.com/lonix/koolbot/issues/1449)) ([c36ea1a](https://github.com/lonix/koolbot/commit/c36ea1a0a4a38927be90ecb47e27c81b558917dd))
* **web-ui:** keep the settings save bar stuck to the viewport ([#1354](https://github.com/lonix/koolbot/issues/1354)) ([dedd915](https://github.com/lonix/koolbot/commit/dedd915cd481f4092b8133d5aba1a9afc0607ae1))
* **web-ui:** let the Randomise options wrap in narrow layouts ([#1442](https://github.com/lonix/koolbot/issues/1442)) ([99dcdc6](https://github.com/lonix/koolbot/commit/99dcdc604ff784b19a0ece04c7abce6926694177))
* **web-ui:** only a two-segment &lt;category&gt;.enabled is a settings cascade master ([#1076](https://github.com/lonix/koolbot/issues/1076)) ([1cb1c63](https://github.com/lonix/koolbot/commit/1cb1c63521fbe4aa86b9dd658f0326566a35eb92))
* **web-ui:** refuse a Keep colour save when the stored value cannot be read ([#1448](https://github.com/lonix/koolbot/issues/1448)) ([a4426f2](https://github.com/lonix/koolbot/commit/a4426f2552bc072f5043cc6f4f1b5ba1adee0a8b))
* **web-ui:** revoke a member's web sessions when they leave, are kicked or banned ([#1167](https://github.com/lonix/koolbot/issues/1167)) ([0f2af2a](https://github.com/lonix/koolbot/commit/0f2af2a19050db8169c27f6ded3bec320fcc95d9))
* **web-ui:** show secrets as present or missing only on the bootstrap page ([#1291](https://github.com/lonix/koolbot/issues/1291)) ([9f4985c](https://github.com/lonix/koolbot/commit/9f4985c44e021853ed4d7725832b1108c7c7022a))


### ♻️ Refactoring

* **events:** remove the /event slash command ([#1284](https://github.com/lonix/koolbot/issues/1284)) ([877024b](https://github.com/lonix/koolbot/commit/877024bd59c0565dee332b5ea6cef6c95b9de0c3))
* one source of truth for the GuildMembers intent guidance ([#1135](https://github.com/lonix/koolbot/issues/1135)) ([381a78f](https://github.com/lonix/koolbot/commit/381a78f2e008f66cb7836f4fa0e389819fec2bfe)), closes [#1132](https://github.com/lonix/koolbot/issues/1132)
* **web-ui:** declare reloadOnSave in settings metadata ([#1099](https://github.com/lonix/koolbot/issues/1099)) ([0be9763](https://github.com/lonix/koolbot/commit/0be9763eeb104c59e3c15b9f50deed73093f6b20))
* **web-ui:** drop the lock-down entries from the bot permission check ([#1464](https://github.com/lonix/koolbot/issues/1464)) ([0f3e73d](https://github.com/lonix/koolbot/commit/0f3e73d34ef28af67f4b0d510c74e687212a8e9e))
* **web-ui:** use Lucide 1.61.0 for all icons ([#1422](https://github.com/lonix/koolbot/issues/1422)) ([f127520](https://github.com/lonix/koolbot/commit/f127520369167e656aa957b367741ae05a877377))


### 📚 Documentation

* correct CLAUDE.md on which config writes trigger a reload ([#1114](https://github.com/lonix/koolbot/issues/1114)) ([62bdc1b](https://github.com/lonix/koolbot/commit/62bdc1b3e6c373e66d4f883ac3e085cedf572be9))
* **design:** a Writing docs section, so the Markdown docs speak like the Web UI in GitHub's shapes ([#1395](https://github.com/lonix/koolbot/issues/1395)) ([c7e818d](https://github.com/lonix/koolbot/commit/c7e818db8c84ce4c2eb3ce9e9630aab0cd0fb88d))
* **design:** brand icons from Tabler and Simple Icons, and the rule for pulling icons into the repo ([#1391](https://github.com/lonix/koolbot/issues/1391)) ([cf41a34](https://github.com/lonix/koolbot/commit/cf41a34c9bfbe6683060764a6901fa904749ebdb))
* **design:** Game servers pages, uptime strip, status posts and role-mention alerts ([#1389](https://github.com/lonix/koolbot/issues/1389)) ([58fbef2](https://github.com/lonix/koolbot/commit/58fbef2e48bccb7a7ed783d98ac0dbc13f8523be))
* give KOOL a meaning, Keeper Of Our Lore ([#1290](https://github.com/lonix/koolbot/issues/1290)) ([18d23cb](https://github.com/lonix/koolbot/commit/18d23cb14a573b203433f7cc8172f800e61eae53))
* point readers at the docs for the latest release, and document pinning the image ([#1404](https://github.com/lonix/koolbot/issues/1404)) ([ca99926](https://github.com/lonix/koolbot/commit/ca9992652f7a54991ac38095357fcfda05441822))
* **security:** correct overstated claims, least-privilege invite, validate WEBUI_BASE_URL scheme ([#1166](https://github.com/lonix/koolbot/issues/1166)) ([d1c778d](https://github.com/lonix/koolbot/commit/d1c778d9d01ef646d792a402aea68a20d23865f1))
* **web-ui:** add the design system for the Web UI and Discord messages ([#1325](https://github.com/lonix/koolbot/issues/1325)) ([e343bab](https://github.com/lonix/koolbot/commit/e343babbfd5c703829eb5345e5c9e4c870827c4b))


### 🧪 Tests

* add opt-in per-model mongoose stubs to the global mock ([#1116](https://github.com/lonix/koolbot/issues/1116)) ([52a2605](https://github.com/lonix/koolbot/commit/52a260581ee74dcb812c91b6f315345f0429c828))
* **adoption:** fixtures 2 and 3 and end-to-end coverage for server adoption ([#1246](https://github.com/lonix/koolbot/issues/1246)) ([63c08db](https://github.com/lonix/koolbot/commit/63c08db1a6cf9007cfc246d20523762bdf6f93ff))
* **ci:** run real-MongoDB integration tests for the Mongoose 9 contracts ([#1109](https://github.com/lonix/koolbot/issues/1109)) ([34bb3f2](https://github.com/lonix/koolbot/commit/34bb3f22af694f1ea3ba29a4532012417e16f4b2))
* migrate more suites to per-model mongoose stubs ([#1128](https://github.com/lonix/koolbot/issues/1128)) ([552dd02](https://github.com/lonix/koolbot/commit/552dd029b2405a38608c8f802fc7b31a3fb91840))
* **web-ui:** gate token contrast and page fixtures from the design system ([#1336](https://github.com/lonix/koolbot/issues/1336)) ([26e9f94](https://github.com/lonix/koolbot/commit/26e9f9424686029c4b8cc70e0ab2257ee69d3dad))
* **web-ui:** nav and scope invariants ([#1360](https://github.com/lonix/koolbot/issues/1360)) ([b8f69e0](https://github.com/lonix/koolbot/commit/b8f69e0a1591728b696ec3db19a5424b7a78eb90))


### ⚙️ CI/CD

* add dry-run stale branch report workflow ([#1273](https://github.com/lonix/koolbot/issues/1273)) ([803e813](https://github.com/lonix/koolbot/commit/803e8138ca86c5b4db87a716b5fddb8c3bcb6c8a))
* add Node 26 to the test matrix ([#1211](https://github.com/lonix/koolbot/issues/1211)) ([f565176](https://github.com/lonix/koolbot/commit/f5651768356c3fc72f920221121e5d9625a2b273))
* add temporary MongoDB kernel probe workflow ([#1275](https://github.com/lonix/koolbot/issues/1275)) ([b0f9a1b](https://github.com/lonix/koolbot/commit/b0f9a1b3f5c2e2e972fec617c2c8cf61f2cad034))
* **deps:** guard package-lock.json against dropped libc constraints ([#1108](https://github.com/lonix/koolbot/issues/1108)) ([803bcf0](https://github.com/lonix/koolbot/commit/803bcf024e0e2c19c9a3e9ec4a9dba45d6c87ef3))
* **docker:** build main nightly; latest tracks the newest release ([#1289](https://github.com/lonix/koolbot/issues/1289)) ([d4dce9c](https://github.com/lonix/koolbot/commit/d4dce9cb4278d141a2527e1ba8ae0cc67236cd77))
* **docker:** gate the image push on hadolint and a pre-push Trivy scan ([#1165](https://github.com/lonix/koolbot/issues/1165)) ([7a9bab8](https://github.com/lonix/koolbot/commit/7a9bab8d45c02b9fce0da7f4d0feff46b9ddc0eb))
* **docker:** label the release PR docker-preview and unlabel it on merge ([#1310](https://github.com/lonix/koolbot/issues/1310)) ([4c826ea](https://github.com/lonix/koolbot/commit/4c826ea9733d494f1a50d1248b19a08adef060d0))
* **docker:** label-triggered preview image builds for PRs ([#1095](https://github.com/lonix/koolbot/issues/1095)) ([28781c7](https://github.com/lonix/koolbot/commit/28781c71c09d6d716eda96eed7f335a028ae4e3f))
* **docker:** lint and test-build Docker changes on pull requests ([#1287](https://github.com/lonix/koolbot/issues/1287)) ([66fba6b](https://github.com/lonix/koolbot/commit/66fba6b8753a9182253bfb5e58c49e84fee8f5f7))
* **docker:** post the preview pull command even though scan-image is skipped on PRs ([#1174](https://github.com/lonix/koolbot/issues/1174)) ([75d3319](https://github.com/lonix/koolbot/commit/75d33191b33eaec734e64ecf22040c559b08bf09))
* **docker:** preview comment states build commit and time, flags outdated previews ([#1334](https://github.com/lonix/koolbot/issues/1334)) ([4b18011](https://github.com/lonix/koolbot/commit/4b1801139921e9b6dd7d2cde9802683ef7db3a77))
* fix workflow triggers and concurrency ([#1288](https://github.com/lonix/koolbot/issues/1288)) ([859068c](https://github.com/lonix/koolbot/commit/859068c7432a80999f7b9e1299a635765b2f23bf))
* harden container and repository hygiene ([#1156](https://github.com/lonix/koolbot/issues/1156)) ([f5aa2b0](https://github.com/lonix/koolbot/commit/f5aa2b04ececeda73fec2eeb3986abe8e261a710))
* make the Copilot setup steps a real workflow ([#1286](https://github.com/lonix/koolbot/issues/1286)) ([02a1c9a](https://github.com/lonix/koolbot/commit/02a1c9adacb6a891de2b53be770617ac299570c4))
* pin GitHub Actions to commit SHAs ([#1178](https://github.com/lonix/koolbot/issues/1178)) ([2216afa](https://github.com/lonix/koolbot/commit/2216afa0976460f024d93d0d8823ca26018b1050))
* raise coverage floors after adoption history landed ([#1138](https://github.com/lonix/koolbot/issues/1138)) ([64d8b20](https://github.com/lonix/koolbot/commit/64d8b202ad137ec180fe3b323d0bb1d0ca97a715))
* raise the branch coverage floor to 78 ([#1358](https://github.com/lonix/koolbot/issues/1358)) ([0f9b7ad](https://github.com/lonix/koolbot/commit/0f9b7ad82aa5d838927fd997087a4daa5416e611))
* run Integration on mongo 7.0 until SERVER-121912 is fixed ([#1270](https://github.com/lonix/koolbot/issues/1270)) ([9567740](https://github.com/lonix/koolbot/commit/9567740db1be42dcf058531e28e55e3792ba294d))
* **web-ui:** collapse the UI preview to a sample when many pages change ([#1355](https://github.com/lonix/koolbot/issues/1355)) ([782d088](https://github.com/lonix/koolbot/commit/782d088e36382948a307ceb34b87f8c754a5314e))
* **web-ui:** comment the UI preview on the PR and screenshot only changed pages ([#1342](https://github.com/lonix/koolbot/issues/1342)) ([ee3d240](https://github.com/lonix/koolbot/commit/ee3d240917e82f081ec50e2e53ed5bd6ef3dd9f4))
* **web-ui:** UI preview screenshots on pull requests that touch the Web UI ([#1329](https://github.com/lonix/koolbot/issues/1329)) ([726427c](https://github.com/lonix/koolbot/commit/726427c7b9f9b46d37ddf2c4ccb9bd8811bff071)), closes [#1327](https://github.com/lonix/koolbot/issues/1327)


### 🔧 Maintenance

* add a maintainer note to the member join handler ([#1140](https://github.com/lonix/koolbot/issues/1140)) ([ca7dd8b](https://github.com/lonix/koolbot/commit/ca7dd8befa174b51d20b9934df5bfa8e45a7743a))
* **logging:** do not warn "connection lost" for the intentional Mongo close at shutdown ([#1309](https://github.com/lonix/koolbot/issues/1309)) ([af7586a](https://github.com/lonix/koolbot/commit/af7586af49b4919e7ae4f0ef594c3916797d7cdf))
* **web-ui:** plain English moderation labels, shared by the Web UI and Discord ([#1372](https://github.com/lonix/koolbot/issues/1372)) ([0ff6af6](https://github.com/lonix/koolbot/commit/0ff6af67fd6593f2bd337e4a16f085396cc87f09))

## [2.0.1](https://github.com/lonix/koolbot/compare/v2.0.0...v2.0.1) (2026-10-04)


### 🐛 Bug Fixes

* **deps:** pin undici to 7.x to restore Discord login ([#1058](https://github.com/lonix/koolbot/issues/1058)) ([8d98737](https://github.com/lonix/koolbot/commit/8d98737aac2589b0cde810447567276bb6584425))


### 📚 Documentation

* refresh documentation for the 2.0 release ([#1057](https://github.com/lonix/koolbot/issues/1057)) ([a080f1b](https://github.com/lonix/koolbot/commit/a080f1b9879c23f98acfdbffd4bc9f9c6768105f))

## [2.0.0](https://github.com/lonix/koolbot/compare/v1.2.2...v2.0.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* **commands:** non-admin members must use /me instead of /config.
* **polls:** drop URL import in favour of file/paste-only import ([#652](https://github.com/lonix/koolbot/issues/652))

### 🚀 Features

* **achievements:** add progress indicators and activate reserved weekly achievements ([#685](https://github.com/lonix/koolbot/issues/685)) ([b8528be](https://github.com/lonix/koolbot/commit/b8528be0ad000821a77f72eec6420bcda4824cb5))
* **aka:** /aka shows a member's previously known names ([#1053](https://github.com/lonix/koolbot/issues/1053)) ([3b965b9](https://github.com/lonix/koolbot/commit/3b965b93276f558a1e1787c13bce5ca9c992dca6))
* **announcements:** one-off "post now" sends + expanded placeholder set ([#712](https://github.com/lonix/koolbot/issues/712)) ([34f2568](https://github.com/lonix/koolbot/commit/34f2568583118e826c6d9565a7aa4d1111f8e4c8))
* **birthdays:** celebrate member birthdays in their own timezone ([#670](https://github.com/lonix/koolbot/issues/670)) ([5325a3a](https://github.com/lonix/koolbot/commit/5325a3a70e40d1b30677c3cdbc5f6c5ec3cbe9fd))
* **celebrations:** announce marquee accolade milestones server-wide ([#657](https://github.com/lonix/koolbot/issues/657)) ([#683](https://github.com/lonix/koolbot/issues/683)) ([9e25697](https://github.com/lonix/koolbot/commit/9e256976e0dabba3c38848fa251e9830dceec907))
* **commands:** add /me for member self-service and make /config admin-only ([#1052](https://github.com/lonix/koolbot/issues/1052)) ([5a53ee7](https://github.com/lonix/koolbot/commit/5a53ee7027ede3629f21f00d8549b9835c310abb))
* **commands:** add /remind for personal one-off reminders ([#902](https://github.com/lonix/koolbot/issues/902)) ([8e63644](https://github.com/lonix/koolbot/commit/8e6364403c51d03265eb5542320c3ffbe99ef46b))
* declare feature dependencies via dependsOn in SettingMetadata ([#669](https://github.com/lonix/koolbot/issues/669)) ([1bc4f5c](https://github.com/lonix/koolbot/commit/1bc4f5cec1bf14931b19c054e6c26fa88c42bdae))
* **digest:** add Web UI digest preview and send-now page ([#668](https://github.com/lonix/koolbot/issues/668)) ([a90821e](https://github.com/lonix/koolbot/commit/a90821eea1d07843cf5b06923272e1635a657426))
* enforce feature dependencies on write ([#672](https://github.com/lonix/koolbot/issues/672)) ([7ca3c5f](https://github.com/lonix/koolbot/commit/7ca3c5f3f31d588ee8238eff9e36589b7d2250c1))
* **events:** scheduled events with temporary voice channels and RSVPs ([#717](https://github.com/lonix/koolbot/issues/717)) ([890e156](https://github.com/lonix/koolbot/commit/890e156194fc79abf0b5dac2df79769dbc318007))
* **lfg:** add /lfg ad-hoc looking-for-group posts ([#961](https://github.com/lonix/koolbot/issues/961)) ([85efc61](https://github.com/lonix/koolbot/commit/85efc61f0fab014b7d25ef11d499d94f1705491d))
* make time-of-day and day-of-week accolades timezone-aware ([#660](https://github.com/lonix/koolbot/issues/660)) ([b8a4190](https://github.com/lonix/koolbot/commit/b8a41900b235c24ce48642c34f28deb6b44ccaa6))
* **moderation:** add /timeout and /ban commands ([#947](https://github.com/lonix/koolbot/issues/947)) ([5b5c25e](https://github.com/lonix/koolbot/commit/5b5c25e4e413f4fc37462d9c93195e510ac7e9c9))
* **moderation:** add lightweight moderation log with /warn, /modlog, and admin page ([#740](https://github.com/lonix/koolbot/issues/740)) ([aa8d822](https://github.com/lonix/koolbot/commit/aa8d822d638b61e68f7fbc1d22e6a49d6f062b34))
* **moderation:** add moderation-log retention config and daily cleanup job ([#789](https://github.com/lonix/koolbot/issues/789)) ([b357ec0](https://github.com/lonix/koolbot/commit/b357ec05d95112771c3916705d19818b2c211dd0))
* **moderation:** surface prior history when an action is recorded ([#944](https://github.com/lonix/koolbot/issues/944)) ([0dc2fa7](https://github.com/lonix/koolbot/commit/0dc2fa7d5b5112265bcb0d6bf147f222b5f34f21))
* **monitoring:** persist command metrics to MongoDB with admin dashboard ([#651](https://github.com/lonix/koolbot/issues/651)) ([5487e15](https://github.com/lonix/koolbot/commit/5487e15ff4d07a7493b0997b0bd9f48d182d3361))
* **notices:** show bot version and every enabled feature in the features notice ([#1015](https://github.com/lonix/koolbot/issues/1015)) ([4be24b4](https://github.com/lonix/koolbot/commit/4be24b45d85d65b0114d58b25a6ec2491c0be6b4))
* **polls:** drop URL import in favour of file/paste-only import ([#652](https://github.com/lonix/koolbot/issues/652)) ([81034a1](https://github.com/lonix/koolbot/commit/81034a15e4e6c8d39e98993d4c42510bf7d0045c))
* **polls:** surface poll participation on Rewind, /me overview, and accolades ([#697](https://github.com/lonix/koolbot/issues/697)) ([3fccd20](https://github.com/lonix/koolbot/commit/3fccd201336cb202362f46bce7373b50790fcc2b))
* **polls:** track weekly vote buckets and per-poll turnout for the recap ([#833](https://github.com/lonix/koolbot/issues/833)) ([0cb1f10](https://github.com/lonix/koolbot/commit/0cb1f107be618935863d827faeada102fd818dbf))
* **privacy:** add an onDelete policy column to the per-user data registry ([#938](https://github.com/lonix/koolbot/issues/938)) ([b7dc237](https://github.com/lonix/koolbot/commit/b7dc237543929f23e38655e4f7d5f044ce48c03c))
* **privacy:** member tracking opt-out, so a data reset becomes a real deletion ([#1011](https://github.com/lonix/koolbot/issues/1011)) ([ea9eb58](https://github.com/lonix/koolbot/commit/ea9eb585824444c08f7647918c23b681c1a2de05))
* **privacy:** never DM users unprompted — make notification DMs opt-in (default off) ([#699](https://github.com/lonix/koolbot/issues/699)) ([eb91e7a](https://github.com/lonix/koolbot/commit/eb91e7a1335f05768b785a86cd440078e68aaac3))
* **privacy:** per-user purge methods on the voice, leaderboard, event and quote services ([#946](https://github.com/lonix/koolbot/issues/946)) ([50649ec](https://github.com/lonix/koolbot/commit/50649ecc0cbcaa9ece599ab584bbcabaf1d28ede)), closes [#914](https://github.com/lonix/koolbot/issues/914)
* **privacy:** UserDataDeletionService — one coordinating per-user purge routine ([#960](https://github.com/lonix/koolbot/issues/960)) ([d100375](https://github.com/lonix/koolbot/commit/d100375a67960be480777e39d0623cd23ebb16e5))
* **quotes:** rank "quote of the week" by votes cast this week ([#915](https://github.com/lonix/koolbot/issues/915)) ([f6a068e](https://github.com/lonix/koolbot/commit/f6a068e5d0bf454e22c7611e8d6ac0cac8d5c1ce))
* **reaction-roles:** add assignment modes and startup/deletion reconciliation ([#823](https://github.com/lonix/koolbot/issues/823)) ([afe5caa](https://github.com/lonix/koolbot/commit/afe5caacf6a276f49ba5ba62ba344d46866f431a))
* **reaction-roles:** multiple mappings per message and bind to existing roles ([#824](https://github.com/lonix/koolbot/issues/824)) ([cd7078e](https://github.com/lonix/koolbot/commit/cd7078e21d0ea5be3fe00d45592f769a960ff144))
* **reactionroles:** add button and select-menu self-assign role surfaces ([#821](https://github.com/lonix/koolbot/issues/821)) ([fe9a182](https://github.com/lonix/koolbot/commit/fe9a1823f91e532c30e840c2a6c7c8cd1e46a693))
* **rewind:** gate voice and achievements sections on their source feature ([#679](https://github.com/lonix/koolbot/issues/679)) ([9fdee79](https://github.com/lonix/koolbot/commit/9fdee795966d2399a4068a6ecbe2b747a45851f6))
* **rewind:** split rewind.enabled into feature and nudge gates ([#624](https://github.com/lonix/koolbot/issues/624)) ([48781e1](https://github.com/lonix/koolbot/commit/48781e17a5d3026d56448577de58e3d7c7cbf3e2))
* **rewind:** voice activity heatmap — hour-of-day & day-of-week patterns ([#698](https://github.com/lonix/koolbot/issues/698)) ([7ef23df](https://github.com/lonix/koolbot/commit/7ef23dfab495b27b78fffefdbf399120897708b8))
* **scripts:** add sample-data seeder for dev/test databases ([#671](https://github.com/lonix/koolbot/issues/671)) ([f431e0f](https://github.com/lonix/koolbot/commit/f431e0fd247d2d9131618b9e5ec69ca8571278d1))
* surface reaction activity on Rewind year-in-review ([#677](https://github.com/lonix/koolbot/issues/677)) ([91f6d3a](https://github.com/lonix/koolbot/commit/91f6d3a54f2e0cf8856291ef3fd78bdd72627e7a))
* **voice:** apply user name pattern and add /me/voice preset management ([#661](https://github.com/lonix/koolbot/issues/661)) ([3865ff5](https://github.com/lonix/koolbot/commit/3865ff5cb35dfbed195a926e5551febeae49b219))
* **voicetracking:** extend weekly recap with quote of the week and poll turnout ([#818](https://github.com/lonix/koolbot/issues/818)) ([dfeebd8](https://github.com/lonix/koolbot/commit/dfeebd82134e4ac745975f4dc5ade75346765415))
* **web:** add a Birthdays admin page ([#1030](https://github.com/lonix/koolbot/issues/1030)) ([874581b](https://github.com/lonix/koolbot/commit/874581bfac08d13aecb8ded4fb7575af9d92409f))
* **web:** add a Leaderboard Roles admin page ([#1014](https://github.com/lonix/koolbot/issues/1014)) ([f1b3da4](https://github.com/lonix/koolbot/commit/f1b3da4aed6aa2c014b79ede16482fc62468a520))
* **web:** add a Quotes admin page ([#1010](https://github.com/lonix/koolbot/issues/1010)) ([967b927](https://github.com/lonix/koolbot/commit/967b9276dd642cfb3f181213780a784fc366b72f))
* **web:** bring setup wizard to parity with the Settings page controls ([#715](https://github.com/lonix/koolbot/issues/715)) ([2bc0cc2](https://github.com/lonix/koolbot/commit/2bc0cc20ddb6b02635b0c980900ebb57c2bfc556))
* **web:** edit Announcements and Moderation settings on their pages ([#993](https://github.com/lonix/koolbot/issues/993)) ([59a605c](https://github.com/lonix/koolbot/commit/59a605c97f66fac0ad5c3bec051270ae8a6028fa)), closes [#977](https://github.com/lonix/koolbot/issues/977)
* **web:** edit Digest settings on the Digest page ([#1006](https://github.com/lonix/koolbot/issues/1006)) ([8658a72](https://github.com/lonix/koolbot/commit/8658a725091f3410acdf6c6875231ded04634991))
* **web:** edit Events settings on the Events page ([#990](https://github.com/lonix/koolbot/issues/990)) ([6e9443c](https://github.com/lonix/koolbot/commit/6e9443c0eeb80c3f93778d6285287c62fe2bd10b))
* **web:** edit Metrics and Command audit settings on their pages ([#1005](https://github.com/lonix/koolbot/issues/1005)) ([f5db420](https://github.com/lonix/koolbot/commit/f5db4205681ef79ebeb64a1d280113693af824cb)), closes [#978](https://github.com/lonix/koolbot/issues/978)
* **web:** edit Notices settings on the Notices page ([#981](https://github.com/lonix/koolbot/issues/981)) ([513b739](https://github.com/lonix/koolbot/commit/513b7392e585b3fb8414fc7737580b3e71edbd68))
* **web:** edit Polls settings on the Polls page ([#987](https://github.com/lonix/koolbot/issues/987)) ([8fcb98f](https://github.com/lonix/koolbot/commit/8fcb98f2112ece451321430a2bdba7dcca501771))
* **web:** edit Reaction Roles settings on the Reaction Roles page ([#982](https://github.com/lonix/koolbot/issues/982)) ([94009a8](https://github.com/lonix/koolbot/commit/94009a8ba949ca241631c020df31bf3be58d9e96))
* **web:** self-service data export from /me/privacy ([#910](https://github.com/lonix/koolbot/issues/910)) ([42dea80](https://github.com/lonix/koolbot/commit/42dea80f46dc45ef31147508ffc95344c5b93f70))
* **web:** self-service data reset from /me/privacy ([#991](https://github.com/lonix/koolbot/issues/991)) ([e24e58e](https://github.com/lonix/koolbot/commit/e24e58e568b518c57c89100feb3f0abb718f1192))
* **web:** show running vs latest release version in the Web UI ([#1031](https://github.com/lonix/koolbot/issues/1031)) ([d59d603](https://github.com/lonix/koolbot/commit/d59d6036b4af65db9916646696eaf4053f7d8b9a))
* **web:** sort enabled features above disabled in wizard and nav ([#710](https://github.com/lonix/koolbot/issues/710)) ([29d6c1a](https://github.com/lonix/koolbot/commit/29d6c1a38a8ca6a13cb8a0b6d7ff3af6eb8617b5)), closes [#706](https://github.com/lonix/koolbot/issues/706)
* **webui:** add retention cleanup for WebAuditLog ([#815](https://github.com/lonix/koolbot/issues/815)) ([4901116](https://github.com/lonix/koolbot/commit/490111699fb52492c7e071ee0aa89ed7432a18a5))
* **webui:** grey out settings toggles with unmet dependencies and a "requires X" hint ([#695](https://github.com/lonix/koolbot/issues/695)) ([e2e0f0b](https://github.com/lonix/koolbot/commit/e2e0f0b3fc07734ff5a0b188bf5a6c38a0ef7bdc))
* **webui:** group admin sidebar nav into labelled sections ([#640](https://github.com/lonix/koolbot/issues/640)) ([8d63152](https://github.com/lonix/koolbot/commit/8d6315229b3f2ab85fa59834975a52b6b7281e29))
* **webui:** make disabled-feature handling consistent across /me/* pages ([#716](https://github.com/lonix/koolbot/issues/716)) ([8244713](https://github.com/lonix/koolbot/commit/8244713f22217a1882d06d0b1def590078bb7a99))
* **webui:** make Voice Channels settings editable in place ([#714](https://github.com/lonix/koolbot/issues/714)) ([0980de2](https://github.com/lonix/koolbot/commit/0980de21f44f2fa9259ec7b45709e9bf6e451956))
* **webui:** surface disabled feature pages in admin nav with enable prompt ([#643](https://github.com/lonix/koolbot/issues/643)) ([4f048fe](https://github.com/lonix/koolbot/commit/4f048fedf88c393c9af5887548259bb24d97d197))
* **web:** wire moderation, events, digest, birthdays, reminders and leaderboard roles into the Setup Wizard ([#1054](https://github.com/lonix/koolbot/issues/1054)) ([ec599d2](https://github.com/lonix/koolbot/commit/ec599d298824878e7c046376da81d6e49ea2dbbd)), closes [#1043](https://github.com/lonix/koolbot/issues/1043)
* wire up quotes.clear_on_sync to rebuild the quote channel on sync ([#676](https://github.com/lonix/koolbot/issues/676)) ([950146f](https://github.com/lonix/koolbot/commit/950146f414b04416449cdb4723f3729de7525dcd))


### 🐛 Bug Fixes

* **achievements:** use ISO week-year in weekly achievement period key ([#801](https://github.com/lonix/koolbot/issues/801)) ([e4457b0](https://github.com/lonix/koolbot/commit/e4457b008cb34792e22642cda1adb81a47470def))
* add Partials.User so reaction-role events fire for uncached users ([#820](https://github.com/lonix/koolbot/issues/820)) ([2bb0ebe](https://github.com/lonix/koolbot/commit/2bb0ebec0356caeef267464ffe002db528560391)), closes [#809](https://github.com/lonix/koolbot/issues/809)
* adopt Prettier 3.9 cast formatting in voice-channel-manager ([#736](https://github.com/lonix/koolbot/issues/736)) ([a1aa3c5](https://github.com/lonix/koolbot/commit/a1aa3c5a787affc88bb54674994c483d52a7363c))
* **cleanup:** prune detail arrays with atomic $pull instead of read-filter-$set ([#798](https://github.com/lonix/koolbot/issues/798)) ([f3243f7](https://github.com/lonix/koolbot/commit/f3243f7914888c8047cc88aab7e2c5792fefe1e6))
* **commands:** defer slow handlers and index sessions.startTime ([#892](https://github.com/lonix/koolbot/issues/892)) ([6fd3476](https://github.com/lonix/koolbot/commit/6fd34768a3e7b53463a53ce589cb93993575e720))
* **commands:** enforce Discord payload limits in /voicestats, /modlog and /achievements ([#887](https://github.com/lonix/koolbot/issues/887)) ([0a0e7f8](https://github.com/lonix/koolbot/commit/0a0e7f8b7d6f1226b924e219bf5a2845d454f094)), closes [#840](https://github.com/lonix/koolbot/issues/840)
* **config:** add celebrations to CONFIG_CATEGORIES so settings survive restart ([#885](https://github.com/lonix/koolbot/issues/885)) ([42f482f](https://github.com/lonix/koolbot/commit/42f482f440a31e24efcdb786b5039752356efa1c)), closes [#834](https://github.com/lonix/koolbot/issues/834)
* **config:** keep env-supplied snowflake ids as strings ([#988](https://github.com/lonix/koolbot/issues/988)) ([0498e45](https://github.com/lonix/koolbot/commit/0498e4584ca14618ce22fa118c9a2e4ce8a38282))
* **config:** source startup-migrator defaults from config-schema ([#871](https://github.com/lonix/koolbot/issues/871)) ([d477366](https://github.com/lonix/koolbot/commit/d477366e3653b3e24e1a5596cb14b8b8b84aeddf))
* **deps:** bump js-yaml to ^4.3.2 (GHSA-2883-xcg3-v3hh) ([#969](https://github.com/lonix/koolbot/issues/969)) ([a29deba](https://github.com/lonix/koolbot/commit/a29deba84f714474a5bdcbe07c165bc3bc2b29e8)), closes [#962](https://github.com/lonix/koolbot/issues/962)
* **deps:** bump undici to ^7.28.0 — clears 7 Trivy + 7 Dependabot alerts ([#694](https://github.com/lonix/koolbot/issues/694)) ([c0fc0de](https://github.com/lonix/koolbot/commit/c0fc0de99dc02f911c2e8458d1fcf3670c286085))
* **deps:** force brace-expansion &gt;=5.0.6 to resolve GHSA-jxxr-4gwj-5jf2 ([#638](https://github.com/lonix/koolbot/issues/638)) ([0cb2b2c](https://github.com/lonix/koolbot/commit/0cb2b2ccafd8e51781536ddd5a6bff8e611b425a))
* **deps:** reference direct deps in overrides so Dependabot can resolve them ([#980](https://github.com/lonix/koolbot/issues/980)) ([e2528c7](https://github.com/lonix/koolbot/commit/e2528c78890899581e0557f88929350b52e88909))
* **deps:** refresh base-image npm to clear bundled undici/tar Trivy alerts ([#696](https://github.com/lonix/koolbot/issues/696)) ([f29666d](https://github.com/lonix/koolbot/commit/f29666d928b73259a49bcd6ed668cc6191c1350b))
* **deps:** refresh js-yaml, undici and brace-expansion pins to clear npm audit ([#827](https://github.com/lonix/koolbot/issues/827)) ([f8c1874](https://github.com/lonix/koolbot/commit/f8c1874fe18c1729ab1c8fe3016f2f302296899e)), closes [#825](https://github.com/lonix/koolbot/issues/825)
* **deps:** resolve remaining npm audit findings (ws / markdown-it / js-yaml / @babel/core toolchain) ([#641](https://github.com/lonix/koolbot/issues/641)) ([4666f89](https://github.com/lonix/koolbot/commit/4666f89a3b5289adc8fd21845033aecebc223b5b)), closes [#639](https://github.com/lonix/koolbot/issues/639)
* **docker:** pin npm version so the refresh layer is not served stale from cache ([#968](https://github.com/lonix/koolbot/issues/968)) ([dddb3e3](https://github.com/lonix/koolbot/commit/dddb3e3cb0c2a6ec7b961d7669d8563de53a625c)), closes [#963](https://github.com/lonix/koolbot/issues/963)
* **docker:** run the dev bot under node --watch so hot reload is real ([#934](https://github.com/lonix/koolbot/issues/934)) ([e5e6cd9](https://github.com/lonix/koolbot/commit/e5e6cd95ef1fde917404cae7fc36edffcbcc307d)), closes [#928](https://github.com/lonix/koolbot/issues/928)
* **events:** atomically claim event channel to prevent duplicate/orphaned channels ([#737](https://github.com/lonix/koolbot/issues/737)) ([437cf5f](https://github.com/lonix/koolbot/commit/437cf5f5402e246e69f32e6fbb735d27db118888))
* **events:** record RSVPs with an atomic update so concurrent clicks are not lost ([#802](https://github.com/lonix/koolbot/issues/802)) ([d302e5e](https://github.com/lonix/koolbot/commit/d302e5efc81d099d1506b84e696447c2d6c7c8d1)), closes [#768](https://github.com/lonix/koolbot/issues/768)
* **export:** match legacy mention-format ids when exporting quotes ([#959](https://github.com/lonix/koolbot/issues/959)) ([2bdd9aa](https://github.com/lonix/koolbot/commit/2bdd9aa86344e653355e25b7e19b1d4274a4b373)), closes [#958](https://github.com/lonix/koolbot/issues/958)
* guard interaction replies in error handlers against unhandled rejections ([#880](https://github.com/lonix/koolbot/issues/880)) ([9b33f73](https://github.com/lonix/koolbot/commit/9b33f73d34a0d31938a935cf7124e864fd655e23))
* **help:** defer /help before reading config ([#1050](https://github.com/lonix/koolbot/issues/1050)) ([46db3dc](https://github.com/lonix/koolbot/commit/46db3dc2de92cc678127181b87c1436195bc093d)), closes [#1042](https://github.com/lonix/koolbot/issues/1042)
* **help:** derive /help from the command registry so commands never go missing ([#886](https://github.com/lonix/koolbot/issues/886)) ([f0b9f27](https://github.com/lonix/koolbot/commit/f0b9f27612e1f2a1e00e3b9907a241e275c30e68))
* **leaderboard-roles:** fetch full ranking so wide tiers are not truncated ([#797](https://github.com/lonix/koolbot/issues/797)) ([5734e46](https://github.com/lonix/koolbot/commit/5734e469a28544434679116f1f3338609dd6e614)), closes [#754](https://github.com/lonix/koolbot/issues/754)
* **logging:** declare the Discord log categories in the config schema ([#890](https://github.com/lonix/koolbot/issues/890)) ([256b6df](https://github.com/lonix/koolbot/commit/256b6df9746135ac93c5f4d5c86fc07ca517d11d)), closes [#844](https://github.com/lonix/koolbot/issues/844)
* make birthday day a month-aware dropdown for consistent input ([#711](https://github.com/lonix/koolbot/issues/711)) ([ee1ac1b](https://github.com/lonix/koolbot/commit/ee1ac1bcf5e90dd31c780c395873d06fb3ec950b))
* **message-cleanup:** stop destroy() from clearing the in-flight run guard ([#790](https://github.com/lonix/koolbot/issues/790)) ([4660367](https://github.com/lonix/koolbot/commit/4660367507c4ec142e70565c172baf5d55874f13)), closes [#779](https://github.com/lonix/koolbot/issues/779)
* **monitoring:** unref periodic logging interval so it can't block shutdown ([#650](https://github.com/lonix/koolbot/issues/650)) ([7dbfbb0](https://github.com/lonix/koolbot/commit/7dbfbb079f1552cc3c4ff87c23ad1ebf2f5dc907)), closes [#647](https://github.com/lonix/koolbot/issues/647)
* **permissions:** fail closed when the permissions cache cannot load ([#879](https://github.com/lonix/koolbot/issues/879)) ([7365994](https://github.com/lonix/koolbot/commit/7365994e8da56054c47f611e4f317d69601e5a56)), closes [#836](https://github.com/lonix/koolbot/issues/836)
* **ping:** guard error handler against double-reply ([#799](https://github.com/lonix/koolbot/issues/799)) ([f287787](https://github.com/lonix/koolbot/commit/f287787be9a1862fb70530fa2d992d7c34264674)), closes [#757](https://github.com/lonix/koolbot/issues/757)
* **polls:** key jobs map by canonical _id in setScheduleEnabled/deleteSchedule ([#791](https://github.com/lonix/koolbot/issues/791)) ([9e7c1b6](https://github.com/lonix/koolbot/commit/9e7c1b651aec1cd9b31692f2140371d128b94a59)), closes [#770](https://github.com/lonix/koolbot/issues/770)
* **privacy:** admission tickets for voice events ([#1039](https://github.com/lonix/koolbot/issues/1039)) ([b99c985](https://github.com/lonix/koolbot/commit/b99c985e4e7bc992810fc46a2b6de61185876eb8))
* **privacy:** close the gaps left in the self-service data reset ([#1041](https://github.com/lonix/koolbot/issues/1041)) ([9190cda](https://github.com/lonix/koolbot/commit/9190cdab1e5e5884f47826fbc85d7f3c1fc7d80b)), closes [#919](https://github.com/lonix/koolbot/issues/919)
* **quotes:** keep posted quote id when reaction step fails ([#805](https://github.com/lonix/koolbot/issues/805)) ([42e5a30](https://github.com/lonix/koolbot/commit/42e5a302765d2280b9093629a519d0d3ac526c97))
* **quotes:** normalize addedById before /quote edit ownership check ([#804](https://github.com/lonix/koolbot/issues/804)) ([080fe0d](https://github.com/lonix/koolbot/commit/080fe0df158ddb2b19a9caca738de03205f23622)), closes [#775](https://github.com/lonix/koolbot/issues/775)
* **reaction-roles:** archive bind-only mappings when the shared message channel is deleted ([#869](https://github.com/lonix/koolbot/issues/869)) ([9c23132](https://github.com/lonix/koolbot/commit/9c23132f41f091ed6d65918a7908946904366d4c)), closes [#860](https://github.com/lonix/koolbot/issues/860)
* **reaction-roles:** archive mappings when the message channel is gone at startup ([#877](https://github.com/lonix/koolbot/issues/877)) ([c6ff207](https://github.com/lonix/koolbot/commit/c6ff207353f71bdbe69a9c1e624d39042e007d2b))
* **scripts:** derive validate-config checks from the config schema ([#872](https://github.com/lonix/koolbot/issues/872)) ([0ad42e0](https://github.com/lonix/koolbot/commit/0ad42e074c7887ec35cd4a3a215d78330b8ff3d3))
* **scripts:** stop migrate-config coercing empty defaults to 0 ([#868](https://github.com/lonix/koolbot/issues/868)) ([14754d4](https://github.com/lonix/koolbot/commit/14754d4e126e39086eb9949bf162b1dfa1dcd36c))
* **setup-wizard:** make wizard apply atomic and report exact per-key outcome ([#793](https://github.com/lonix/koolbot/issues/793)) ([2dffb96](https://github.com/lonix/koolbot/commit/2dffb96d2c789e0035a249f67185d5cdf3441e81))
* unref periodic interval timers so they can't block process exit ([#726](https://github.com/lonix/koolbot/issues/726)) ([b581eb8](https://github.com/lonix/koolbot/commit/b581eb840d7686a734e67c3c3ae7d905dd3527d5)), closes [#718](https://github.com/lonix/koolbot/issues/718)
* unref remaining readiness-poll and ownership-transfer timers ([#738](https://github.com/lonix/koolbot/issues/738)) ([f0f1e4c](https://github.com/lonix/koolbot/commit/f0f1e4c2031a7668a12fa84ed5483ca373df560d)), closes [#729](https://github.com/lonix/koolbot/issues/729)
* **voice-cleanup:** register config-reload callback so /config reload reschedules or stops the cleanup cron ([#794](https://github.com/lonix/koolbot/issues/794)) ([3339311](https://github.com/lonix/koolbot/commit/3339311a5fe4b5f0b8da98098be8facd04f273e1))
* **voice-presets:** guard Discord preset actions against stale panel indexes ([#803](https://github.com/lonix/koolbot/issues/803)) ([4f0b42a](https://github.com/lonix/koolbot/commit/4f0b42af41829f5905696ee3fe50754158f40d92)), closes [#759](https://github.com/lonix/koolbot/issues/759)
* **voice:** keep voicetracking.cleanup.last_run across restarts ([#883](https://github.com/lonix/koolbot/issues/883)) ([efbd96c](https://github.com/lonix/koolbot/commit/efbd96c9ad815c3350e9519c59f9fc3d7388f21c)), closes [#838](https://github.com/lonix/koolbot/issues/838)
* **voice:** never let the cleanup sweep delete the offline lobby or occupied channels ([#889](https://github.com/lonix/koolbot/issues/889)) ([2abfd6d](https://github.com/lonix/koolbot/commit/2abfd6d40e5b47dba40c43adb699d3f03db109cb)), closes [#843](https://github.com/lonix/koolbot/issues/843)
* **voice:** re-create lobby immediately after rename deletes the old one ([#632](https://github.com/lonix/koolbot/issues/632)) ([469d057](https://github.com/lonix/koolbot/commit/469d057ecbe8800dd392c1e2be7776b211c1b555)), closes [#631](https://github.com/lonix/koolbot/issues/631)
* **voicestats:** show the five most recent sessions, newest first ([#884](https://github.com/lonix/koolbot/issues/884)) ([637aa1c](https://github.com/lonix/koolbot/commit/637aa1c07d8edea4188bcf28cb59324bbad08160)), closes [#841](https://github.com/lonix/koolbot/issues/841)
* **voice:** use the configured lobby when renaming it offline on shutdown ([#878](https://github.com/lonix/koolbot/issues/878)) ([a07b212](https://github.com/lonix/koolbot/commit/a07b21274cbd16458968cbcae2b8dcc4d87c49b7))
* warn and short-circuit when leaderboard/digest/achievements run with voice tracking disabled ([#678](https://github.com/lonix/koolbot/issues/678)) ([6722fac](https://github.com/lonix/koolbot/commit/6722fac43bb37798b426f3e45f3fb0d45ebeafcf))
* **web:** close the remaining feature-page settings gaps ([#1040](https://github.com/lonix/koolbot/issues/1040)) ([1086669](https://github.com/lonix/koolbot/commit/1086669eee042e90bcf28d05a8ce31e9326ee849))
* **web:** close the WCAG 2.1 AA gaps in the admin and /me pages ([#893](https://github.com/lonix/koolbot/issues/893)) ([b319e18](https://github.com/lonix/koolbot/commit/b319e18da2f2f63bff423d888316d93736940429))
* **web:** fail closed when the config snapshot can't be read on settings pages ([#989](https://github.com/lonix/koolbot/issues/989)) ([1312ea5](https://github.com/lonix/koolbot/commit/1312ea59ff3f1e4478f0a39660cae7662742f35f))
* **web:** purge a birthday safely when a member clears it on /me/birthday ([#1036](https://github.com/lonix/koolbot/issues/1036)) ([7ea3d3d](https://github.com/lonix/koolbot/commit/7ea3d3d29f6b093912b0b2910da627df2be63e12))
* **web:** re-arm every scheduled service when its schedule or enable flag is saved ([#1037](https://github.com/lonix/koolbot/issues/1037)) ([03ab500](https://github.com/lonix/koolbot/commit/03ab5003a0a0966aa397ca6a65b73eacf7b3ab84))
* **web:** refuse blank number input and make 0 mean keep-forever on every retention key ([#888](https://github.com/lonix/koolbot/issues/888)) ([9d3a42d](https://github.com/lonix/koolbot/commit/9d3a42d86d001757c7442a25be67a28eddfc9eb8))
* **webui:** associate Settings controls with their labels and error messages ([#881](https://github.com/lonix/koolbot/issues/881)) ([cc2bb62](https://github.com/lonix/koolbot/commit/cc2bb62657727428170c83845e941280cc106877))
* **webui:** do not revoke sessions when the permission re-check fails transiently ([#795](https://github.com/lonix/koolbot/issues/795)) ([42d2e60](https://github.com/lonix/koolbot/commit/42d2e60a376633056f6debecf668f930c6652086))
* **webui:** require CSRF token on magic-link redemption to stop login CSRF ([#806](https://github.com/lonix/koolbot/issues/806)) ([13607b0](https://github.com/lonix/koolbot/commit/13607b02989a8c2be7de314de3cf9616523fb39c))
* **webui:** treat malformed ids as not-found in announcement/poll-schedule lookups ([#800](https://github.com/lonix/koolbot/issues/800)) ([3d5b6ea](https://github.com/lonix/koolbot/commit/3d5b6ea346273a886211a904dd7dfa35a4a754d9))
* **wizard:** correct interval type and harden cleanup timer ([#649](https://github.com/lonix/koolbot/issues/649)) ([c41137f](https://github.com/lonix/koolbot/commit/c41137f77bfff6102ebe5dd40fecb488b79f97be)), closes [#645](https://github.com/lonix/koolbot/issues/645)
* **wizard:** render channel/category/role keys as proper selectors ([#713](https://github.com/lonix/koolbot/issues/713)) ([ae5871a](https://github.com/lonix/koolbot/commit/ae5871a65b3a6328e067fab2d87b7496bbfff257))


### ♻️ Refactoring

* migrate ephemeral replies to MessageFlags.Ephemeral ([#896](https://github.com/lonix/koolbot/issues/896)) ([fca1e78](https://github.com/lonix/koolbot/commit/fca1e788fa584a5b1775c42140c6b0c717b0cbed))
* migrate message and voice cleanup services onto ScheduledService ([#1051](https://github.com/lonix/koolbot/issues/1051)) ([020a95d](https://github.com/lonix/koolbot/commit/020a95d10c938842e47020292c2f087239ea92cc)), closes [#1044](https://github.com/lonix/koolbot/issues/1044)
* **reaction-roles:** route gateway events through src/index.ts ([#819](https://github.com/lonix/koolbot/issues/819)) ([0a50af6](https://github.com/lonix/koolbot/commit/0a50af6f5a6209ad99b70ea9b59801a132e0b3c3))
* **services:** extract duplicated cron, mongo, readiness and HTML helpers ([#909](https://github.com/lonix/koolbot/issues/909)) ([d29ebc8](https://github.com/lonix/koolbot/commit/d29ebc8d7e53b1931950fd118cc05f3d0db9ffcd))
* **services:** extract the shared cron-job lifecycle into ScheduledService ([#912](https://github.com/lonix/koolbot/issues/912)) ([99e2ec6](https://github.com/lonix/koolbot/commit/99e2ec69a2f1b04b96d057ab1d5364e2bb6d0551))
* **web:** move Voice Channels settings card onto the shared component ([#992](https://github.com/lonix/koolbot/issues/992)) ([9d6cdae](https://github.com/lonix/koolbot/commit/9d6cdaedeca627f5412add779c813c1e0a52591c)), closes [#979](https://github.com/lonix/koolbot/issues/979)
* **web:** reusable feature-page settings card with enable/disable toggle ([#983](https://github.com/lonix/koolbot/issues/983)) ([e5af487](https://github.com/lonix/koolbot/commit/e5af487c1ab7e4d73b3a279d904f662a61471997))
* **web:** split write-routes into per-domain routers ([#897](https://github.com/lonix/koolbot/issues/897)) ([94d2861](https://github.com/lonix/koolbot/commit/94d28616ddcbda91acf83a0969823e6b2bdd7477))


### 📚 Documentation

* add hand-written KoolBot 2.0 release notes ([#1056](https://github.com/lonix/koolbot/issues/1056)) ([fbebde4](https://github.com/lonix/koolbot/commit/fbebde400fe999134e1905c258d284a1968937b1))
* **contributing:** align commit-type list with pr-title-lint ([#931](https://github.com/lonix/koolbot/issues/931)) ([e5734cc](https://github.com/lonix/koolbot/commit/e5734cc583f09381d8d83ad95ea2d7d3337440a4)), closes [#925](https://github.com/lonix/koolbot/issues/925)
* correct stale references to retired admin slash commands ([#899](https://github.com/lonix/koolbot/issues/899)) ([5c7161d](https://github.com/lonix/koolbot/commit/5c7161db54dfd77d95e7086b37e7da991f33bc6f))
* note benign glob deprecation warning from Jest toolchain ([#636](https://github.com/lonix/koolbot/issues/636)) ([b9685ae](https://github.com/lonix/koolbot/commit/b9685aed5d5d3933d59336356b83d5a969a5720e)), closes [#605](https://github.com/lonix/koolbot/issues/605)
* point the wizard instructions at the Web UI instead of the retired /setup command ([#933](https://github.com/lonix/koolbot/issues/933)) ([1eb1a79](https://github.com/lonix/koolbot/commit/1eb1a79c02d724ac001c8dcf059a7184f3cb580c)), closes [#921](https://github.com/lonix/koolbot/issues/921)
* **reaction-roles:** document Web-UI-only admin surface, drop stale /reactrole references ([#822](https://github.com/lonix/koolbot/issues/822)) ([0a4f1fe](https://github.com/lonix/koolbot/commit/0a4f1fedeeaf5cee3d785b3e63d5bcc06d3ecd01))
* **readme:** add /remind and the Reminders/Privacy config categories ([#937](https://github.com/lonix/koolbot/issues/937)) ([4aa0c31](https://github.com/lonix/koolbot/commit/4aa0c31929daa8ffe4603fef3d032ed3f13035ca)), closes [#923](https://github.com/lonix/koolbot/issues/923)
* record the self-hosted design principle in CLAUDE.md ([#1028](https://github.com/lonix/koolbot/issues/1028)) ([95a4ec1](https://github.com/lonix/koolbot/commit/95a4ec1eb5248befd6a207d5faa9d70704d4c5df))
* refresh the src/ architecture trees and document config/env.ts ([#935](https://github.com/lonix/koolbot/issues/935)) ([0313ddf](https://github.com/lonix/koolbot/commit/0313ddfd6fc2e8b70a5041aa177ab74f53b6da91)), closes [#927](https://github.com/lonix/koolbot/issues/927)
* remove undocumented quotes.add_roles config key references ([#701](https://github.com/lonix/koolbot/issues/701)) ([796b6d5](https://github.com/lonix/koolbot/commit/796b6d54cf1723b7438ffaf7ecd909b31e03e3d3)), closes [#680](https://github.com/lonix/koolbot/issues/680)
* require rebase before PR and resolving handled review comments ([#700](https://github.com/lonix/koolbot/issues/700)) ([1f19053](https://github.com/lonix/koolbot/commit/1f19053e497419f343518232d91231e564bdd835))
* **security:** make the supported-versions policy self-maintaining ([#930](https://github.com/lonix/koolbot/issues/930)) ([5f38802](https://github.com/lonix/koolbot/commit/5f38802b845e14d42edde98601ced317d0ea7c8d)), closes [#926](https://github.com/lonix/koolbot/issues/926)
* **settings:** fix phantom config keys and document the four missing ones ([#901](https://github.com/lonix/koolbot/issues/901)) ([721a368](https://github.com/lonix/koolbot/commit/721a36879292862d19b5c97e60341b0769752b0d))
* stop restating coverage floors in CLAUDE.md and CONTRIBUTING.md ([#932](https://github.com/lonix/koolbot/issues/932)) ([8b06518](https://github.com/lonix/koolbot/commit/8b065189db501ff9d75f3dd7ba9dd74c482a68d4)), closes [#920](https://github.com/lonix/koolbot/issues/920)
* **testing:** point CI Integration at ci.yml instead of a missing test.yml ([#929](https://github.com/lonix/koolbot/issues/929)) ([24bb782](https://github.com/lonix/koolbot/commit/24bb78221de55c1de511d9bf64417c8b77cfbbd9)), closes [#924](https://github.com/lonix/koolbot/issues/924)
* **web:** drop retired slash-command names from admin page subtitles ([#936](https://github.com/lonix/koolbot/issues/936)) ([435c4dd](https://github.com/lonix/koolbot/commit/435c4dda0d85915e5baa909e5d0dd2fdd7c19ff3)), closes [#922](https://github.com/lonix/koolbot/issues/922)
* **webui:** document /admin/moderation and /admin/events pages ([#807](https://github.com/lonix/koolbot/issues/807)) ([aaa868f](https://github.com/lonix/koolbot/commit/aaa868f027b65d51f1f17eb0f0a2b6b4f6c977be))


### 🧪 Tests

* cover name-id-migrator startup migration ([#1012](https://github.com/lonix/koolbot/issues/1012)) ([f949b1c](https://github.com/lonix/koolbot/commit/f949b1caf39ef9ebcdad493b28d3dbabc24904ed)), closes [#1008](https://github.com/lonix/koolbot/issues/1008)
* cover the admin write surface, command handlers and placeholder gaps ([#904](https://github.com/lonix/koolbot/issues/904)) ([eb6a219](https://github.com/lonix/koolbot/commit/eb6a219740f09dde3fd78bbacbcd4ed555515260))
* raise coverage floors to match actual coverage and guard against drift ([#900](https://github.com/lonix/koolbot/issues/900)) ([1cb8350](https://github.com/lonix/koolbot/commit/1cb8350867252dc168f947ba6fbbcc0d28db6326))
* **web:** assert 401 exactly on every unauthenticated write path ([#905](https://github.com/lonix/koolbot/issues/905)) ([9b35780](https://github.com/lonix/koolbot/commit/9b35780bc0878f7a420675851cb8ca877d9d11b9))
* **web:** gate the WebUI on automated accessibility checks ([#903](https://github.com/lonix/koolbot/issues/903)) ([2aad3c4](https://github.com/lonix/koolbot/commit/2aad3c477e9e418e70748ce977f45f7cd7db259f))


### 🏗️ Build

* **deps:** bump Docker base image to node:24-alpine ([#634](https://github.com/lonix/koolbot/issues/634)) ([4881f06](https://github.com/lonix/koolbot/commit/4881f06d0b01abc897296fe412b08c0a24c9bc79))
* **docker:** drop no-op OpenSSL stopgap now node:24-alpine is patched ([#642](https://github.com/lonix/koolbot/issues/642)) ([b44a72f](https://github.com/lonix/koolbot/commit/b44a72f129071ffd2e1be6c92439d3815c014700)), closes [#604](https://github.com/lonix/koolbot/issues/604)
* **docker:** use exec-form HEALTHCHECK and run node directly ([#967](https://github.com/lonix/koolbot/issues/967)) ([f9a0167](https://github.com/lonix/koolbot/commit/f9a016705399c98c2c7db8481292221b78dec905)), closes [#964](https://github.com/lonix/koolbot/issues/964)
* **docker:** use numeric USER 1000:1000 so runAsNonRoot can verify the image ([#966](https://github.com/lonix/koolbot/issues/966)) ([5d5e8e3](https://github.com/lonix/koolbot/commit/5d5e8e30a27b614a2cd890a42672dfdfac8f752d)), closes [#965](https://github.com/lonix/koolbot/issues/965)


### ⚙️ CI/CD

* auto-label issues and pull requests ([#898](https://github.com/lonix/koolbot/issues/898)) ([eebb2d6](https://github.com/lonix/koolbot/commit/eebb2d6d547972466575412da3257242b29a9179))
* **deps:** add Dependabot security-updates group for npm ([#687](https://github.com/lonix/koolbot/issues/687)) ([bc284dd](https://github.com/lonix/koolbot/commit/bc284ddc8e8cb57146af8d344cae34e5bae5f512)), closes [#684](https://github.com/lonix/koolbot/issues/684)
* **deps:** ignore typescript 7.0.x until [#792](https://github.com/lonix/koolbot/issues/792) is unblocked ([#994](https://github.com/lonix/koolbot/issues/994)) ([0953c36](https://github.com/lonix/koolbot/commit/0953c363967ed8683197d39b13a6567360b47971))


### 🔧 Maintenance

* bring the toolchain up to date with the linter, runtime and image ([#895](https://github.com/lonix/koolbot/issues/895)) ([432495f](https://github.com/lonix/koolbot/commit/432495ff728167605193e9c1c2b629bc6fa7a127)), closes [#853](https://github.com/lonix/koolbot/issues/853)
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
