# Changelog

## [0.29.5](https://github.com/salimhamed/jigs/compare/jigs-v0.29.4...jigs-v0.29.5) (2026-09-17)


### Features

* **worktrees:** discard cancelled run worktrees ([87a7131](https://github.com/salimhamed/jigs/commit/87a713111f6f78420978a2949e7da14d764dabac))

## [0.29.4](https://github.com/salimhamed/jigs/compare/jigs-v0.29.3...jigs-v0.29.4) (2026-09-17)


### Bug Fixes

* render empty ticket comments section ([a4c09f4](https://github.com/salimhamed/jigs/commit/a4c09f41302a4a54a4616660e776516ce21890be))

## [0.29.3](https://github.com/salimhamed/jigs/compare/jigs-v0.29.2...jigs-v0.29.3) (2026-09-16)


### Features

* route github status events to pull request gates ([5a92e3d](https://github.com/salimhamed/jigs/commit/5a92e3d1a64ce55b336310cb4380ac7f4e020338))

## [0.29.2](https://github.com/salimhamed/jigs/compare/jigs-v0.29.1...jigs-v0.29.2) (2026-09-16)


### Features

* add pull request review step ([2e28991](https://github.com/salimhamed/jigs/commit/2e28991995a370a18abf8b0ce964557df4f36082))

## [0.29.1](https://github.com/salimhamed/jigs/compare/jigs-v0.29.0...jigs-v0.29.1) (2026-09-16)


### Bug Fixes

* preserve binding config formatting ([526fd5b](https://github.com/salimhamed/jigs/commit/526fd5b59aaecb6624d810229723d797f629629b))

## [0.29.0](https://github.com/salimhamed/jigs/compare/jigs-v0.28.1...jigs-v0.29.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* openPullRequest now accepts a single request object instead of positional arguments.

### Features

* add draft pull request steps ([6e5f940](https://github.com/salimhamed/jigs/commit/6e5f940194f4ddc110879baa1d64af3af76d51b7))

## [0.28.1](https://github.com/salimhamed/jigs/compare/jigs-v0.28.0...jigs-v0.28.1) (2026-09-16)


### Bug Fixes

* **service:** delete a cancelled run's leftover queue jobs ([#230](https://github.com/salimhamed/jigs/issues/230)) ([88c3ba7](https://github.com/salimhamed/jigs/commit/88c3ba7aae2fe3a3a09cd5674eac4fb2813e4e92))
* **test:** build the cloned-binding fixture once instead of per test ([#234](https://github.com/salimhamed/jigs/issues/234)) ([b45c407](https://github.com/salimhamed/jigs/commit/b45c4074ae88e3bc320929b6ecd9a0c5ed86bd53))

## [0.28.0](https://github.com/salimhamed/jigs/compare/jigs-v0.27.0...jigs-v0.28.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **agents:** HarnessOptions is now a harness-discriminated union.

### Features

* **agents:** add harness effort settings ([ed15200](https://github.com/salimhamed/jigs/commit/ed152008676944cff7ad44a46ac25379003b2546))

## [0.27.0](https://github.com/salimhamed/jigs/compare/jigs-v0.26.2...jigs-v0.27.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* make a running pipeline visible from the terminal ([#224](https://github.com/salimhamed/jigs/issues/224))

### Features

* make a running pipeline visible from the terminal ([#224](https://github.com/salimhamed/jigs/issues/224)) ([f911664](https://github.com/salimhamed/jigs/commit/f91166427934c829939615f5efc0100a93945434))

## [0.26.2](https://github.com/salimhamed/jigs/compare/jigs-v0.26.1...jigs-v0.26.2) (2026-09-16)


### Bug Fixes

* retry thrown merge errors ([b2dde32](https://github.com/salimhamed/jigs/commit/b2dde3272cb1b70df5005b675485abae5a853c1a))

## [0.26.1](https://github.com/salimhamed/jigs/compare/jigs-v0.26.0...jigs-v0.26.1) (2026-09-16)


### Bug Fixes

* **doctor:** stop flagging repositories that do not require CI or reviews ([#219](https://github.com/salimhamed/jigs/issues/219)) ([466ce82](https://github.com/salimhamed/jigs/commit/466ce8262e6e040724fb0b7114423b8c32717916))

## [0.26.0](https://github.com/salimhamed/jigs/compare/jigs-v0.25.2...jigs-v0.26.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* report repository settings instead of changing them ([#217](https://github.com/salimhamed/jigs/issues/217))

### Features

* report repository settings instead of changing them ([#217](https://github.com/salimhamed/jigs/issues/217)) ([c6fb06e](https://github.com/salimhamed/jigs/commit/c6fb06e77333849793722bbe33ea596059ed55ed))

## [0.25.2](https://github.com/salimhamed/jigs/compare/jigs-v0.25.1...jigs-v0.25.2) (2026-09-16)


### Bug Fixes

* **ticket:** ask ticket-review questions in one round ([9b41108](https://github.com/salimhamed/jigs/commit/9b41108310419bdd6fc78d84014c98bb83ddc7d2))

## [0.25.1](https://github.com/salimhamed/jigs/compare/jigs-v0.25.0...jigs-v0.25.1) (2026-09-16)


### Bug Fixes

* check input-selected workflow bindings in preflight ([e7edc6d](https://github.com/salimhamed/jigs/commit/e7edc6d8e6533f043973afaf723db878fae6d26d))

## [0.25.0](https://github.com/salimhamed/jigs/compare/jigs-v0.24.1...jigs-v0.25.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **repo:** GitHub App factories must grant Administration read and write and accept the updated installation permission.

### Features

* **repo:** add opt-in repository setup command ([f8d7d6d](https://github.com/salimhamed/jigs/commit/f8d7d6d230cd00e474d9e680f8d8a6b5067eb508))

## [0.24.1](https://github.com/salimhamed/jigs/compare/jigs-v0.24.0...jigs-v0.24.1) (2026-09-16)


### Features

* **bind:** ensure configured approval label ([0608d37](https://github.com/salimhamed/jigs/commit/0608d37b5976fb2a84710fad2f0b76578d4674bd))

## [0.24.0](https://github.com/salimhamed/jigs/compare/jigs-v0.23.3...jigs-v0.24.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* resolveMergePolicy now requires a binding name and the scaffolded ship workflow no longer accepts a merge input.

### Features

* let bindings override merge policy ([f887bca](https://github.com/salimhamed/jigs/commit/f887bca07d508cf7d6266e357ed00fe30410e5bb))

## [0.23.3](https://github.com/salimhamed/jigs/compare/jigs-v0.23.2...jigs-v0.23.3) (2026-09-16)


### Features

* **service:** run factory services in systemd user scopes ([5c3334f](https://github.com/salimhamed/jigs/commit/5c3334f4e8a4d3179ac541b6dbab69f7e1b31c3f))

## [0.23.2](https://github.com/salimhamed/jigs/compare/jigs-v0.23.1...jigs-v0.23.2) (2026-09-16)


### Bug Fixes

* **agent:** emit strict-mode JSON schemas for Codex structured output ([#203](https://github.com/salimhamed/jigs/issues/203)) ([b20f85d](https://github.com/salimhamed/jigs/commit/b20f85dabe27d7f0a5139c79f231146a43bf7b90))

## [0.23.1](https://github.com/salimhamed/jigs/compare/jigs-v0.23.0...jigs-v0.23.1) (2026-09-16)


### Bug Fixes

* **pull-request:** retry merges refused for transient states instead of standing the commit down ([#201](https://github.com/salimhamed/jigs/issues/201)) ([7779648](https://github.com/salimhamed/jigs/commit/77796487444802e33739795b1080cef639aa40ba))

## [0.23.0](https://github.com/salimhamed/jigs/compare/jigs-v0.22.0...jigs-v0.23.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* check bound repos against the merge policy

### Features

* check bound repos against the merge policy ([53cf1bf](https://github.com/salimhamed/jigs/commit/53cf1bf17c48cfdb0b816cc0202bd083df6bf8e2))

## [0.22.0](https://github.com/salimhamed/jigs/compare/jigs-v0.21.0...jigs-v0.22.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* **delivery:** WorkItem gains a required `id` (the ticket source address, e.g. the Linear issue UUID) beside `key`; DeliverySteps gains a required `postTicketNote`; TicketNote reshaped and renderProceedingNote renamed to renderTicketNote. Factories set `id: handoff.snapshot.id` in their ticket block and wire postTicketNote into deliverySteps.

### Features

* **delivery:** block reviews on defects, and let the reviewer remember ([#196](https://github.com/salimhamed/jigs/issues/196)) ([b66fe92](https://github.com/salimhamed/jigs/commit/b66fe92161276b4626f79b1dc38eb0c06f9ddd9d))

## [0.21.0](https://github.com/salimhamed/jigs/compare/jigs-v0.20.0...jigs-v0.21.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* two GitHub identities, and merge policy as configuration ([#194](https://github.com/salimhamed/jigs/issues/194))

### Features

* two GitHub identities, and merge policy as configuration ([#194](https://github.com/salimhamed/jigs/issues/194)) ([f3122bf](https://github.com/salimhamed/jigs/commit/f3122bf92ca385b1d622b16f2642021494ad91af))

## [0.20.0](https://github.com/salimhamed/jigs/compare/jigs-v0.19.0...jigs-v0.20.0) (2026-09-16)


### ⚠ BREAKING CHANGES

* keep pull request progress on GitHub as comment markers ([#192](https://github.com/salimhamed/jigs/issues/192))

### Features

* keep pull request progress on GitHub as comment markers ([#192](https://github.com/salimhamed/jigs/issues/192)) ([c30b068](https://github.com/salimhamed/jigs/commit/c30b06851c58249e43fb518cd39b91c28511ead0))

## [0.19.0](https://github.com/salimhamed/jigs/compare/jigs-v0.18.1...jigs-v0.19.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* post a revision summary only when a commit lands ([#190](https://github.com/salimhamed/jigs/issues/190))

### Bug Fixes

* post a revision summary only when a commit lands ([#190](https://github.com/salimhamed/jigs/issues/190)) ([cd42934](https://github.com/salimhamed/jigs/commit/cd42934d47951176100d693747869f4f7ae1f4fb))

## [0.18.1](https://github.com/salimhamed/jigs/compare/jigs-v0.18.0...jigs-v0.18.1) (2026-09-13)


### Bug Fixes

* match an existing binding by remote when bind derives the name ([#188](https://github.com/salimhamed/jigs/issues/188)) ([b477216](https://github.com/salimhamed/jigs/commit/b47721679ec0ba403174e08cfe8657823f4f6295))

## [0.18.0](https://github.com/salimhamed/jigs/compare/jigs-v0.17.0...jigs-v0.18.0) (2026-09-13)


### ⚠ BREAKING CHANGES

* run the operator's codex and refuse to start without it ([#184](https://github.com/salimhamed/jigs/issues/184))

### Bug Fixes

* run the operator's codex and refuse to start without it ([#184](https://github.com/salimhamed/jigs/issues/184)) ([5782a75](https://github.com/salimhamed/jigs/commit/5782a75d77a1aeb500ebef5e99b3ce4052c03043))

## [0.17.0](https://github.com/salimhamed/jigs/compare/jigs-v0.16.0...jigs-v0.17.0) (2026-09-13)


### ⚠ BREAKING CHANGES

* wake runs on top-level PR comments and track self-posted comment ids ([#183](https://github.com/salimhamed/jigs/issues/183))

### Features

* wake runs on top-level PR comments and track self-posted comment ids ([#183](https://github.com/salimhamed/jigs/issues/183)) ([3e58017](https://github.com/salimhamed/jigs/commit/3e580175daf2ab6eddad3fe98b651b50ac918e46))

## [0.16.0](https://github.com/salimhamed/jigs/compare/jigs-v0.15.0...jigs-v0.16.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* enforce approved publication and clarify factory operations ([#178](https://github.com/salimhamed/jigs/issues/178))

### Bug Fixes

* enforce approved publication and clarify factory operations ([#178](https://github.com/salimhamed/jigs/issues/178)) ([ce653bc](https://github.com/salimhamed/jigs/commit/ce653bcc04961f26dbf9e0c1728ea53ac7d5cf6a))

## [0.15.0](https://github.com/salimhamed/jigs/compare/jigs-v0.14.0...jigs-v0.15.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* document the delivery shape and rename DeliveryLimit to LimitReached ([#176](https://github.com/salimhamed/jigs/issues/176))

### Features

* document the delivery shape and rename DeliveryLimit to LimitReached ([#176](https://github.com/salimhamed/jigs/issues/176)) ([613cfdd](https://github.com/salimhamed/jigs/commit/613cfdd9cbebcb2752c96631c37070264d2edb35))

## [0.14.0](https://github.com/salimhamed/jigs/compare/jigs-v0.13.0...jigs-v0.14.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* anchor factory imports at the project root ([#174](https://github.com/salimhamed/jigs/issues/174))

### Features

* anchor factory imports at the project root ([#174](https://github.com/salimhamed/jigs/issues/174)) ([e11ecd5](https://github.com/salimhamed/jigs/commit/e11ecd5929c1945fa08dd8e2e50f1080d036c1e3))

## [0.13.0](https://github.com/salimhamed/jigs/compare/jigs-v0.12.0...jigs-v0.13.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* give every author-facing operation one canonical name ([#172](https://github.com/salimhamed/jigs/issues/172))

### Features

* give every author-facing operation one canonical name ([#172](https://github.com/salimhamed/jigs/issues/172)) ([48a12f5](https://github.com/salimhamed/jigs/commit/48a12f5901618a89ece7b02626af74b841ce4f86))

## [0.12.0](https://github.com/salimhamed/jigs/compare/jigs-v0.11.0...jigs-v0.12.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* give each delivery role its own prompt context and preserve custom task fields ([#170](https://github.com/salimhamed/jigs/issues/170))

### Features

* give each delivery role its own prompt context and preserve custom task fields ([#170](https://github.com/salimhamed/jigs/issues/170)) ([2919131](https://github.com/salimhamed/jigs/commit/2919131109fbaf122ff1a9475e82bbb08986592f))

## [0.11.0](https://github.com/salimhamed/jigs/compare/jigs-v0.10.0...jigs-v0.11.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* review committed work and publish only the approved commit ([#168](https://github.com/salimhamed/jigs/issues/168))

### Features

* review committed work and publish only the approved commit ([#168](https://github.com/salimhamed/jigs/issues/168)) ([55dd9ec](https://github.com/salimhamed/jigs/commit/55dd9ec4bcedf1b8ec302ea9ecd499b90d89097a))

## [0.10.0](https://github.com/salimhamed/jigs/compare/jigs-v0.9.0...jigs-v0.10.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* make factory delivery configurable and provider independent ([#166](https://github.com/salimhamed/jigs/issues/166))

### Features

* make factory delivery configurable and provider independent ([#166](https://github.com/salimhamed/jigs/issues/166)) ([5e1538b](https://github.com/salimhamed/jigs/commit/5e1538bd89c7f4789e189bdf7d6182ddf5823d57))

## [0.9.0](https://github.com/salimhamed/jigs/compare/jigs-v0.8.0...jigs-v0.9.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* clarify factory operations and generated code ([#163](https://github.com/salimhamed/jigs/issues/163))

### Features

* clarify factory operations and generated code ([#163](https://github.com/salimhamed/jigs/issues/163)) ([cc765d1](https://github.com/salimhamed/jigs/commit/cc765d135229acc5a4995f44ff4cf6834008f01a))

## [0.8.0](https://github.com/salimhamed/jigs/compare/jigs-v0.7.0...jigs-v0.8.0) (2026-09-12)


### ⚠ BREAKING CHANGES

* simplify factory configuration and generated integration ([#161](https://github.com/salimhamed/jigs/issues/161))

### Features

* simplify factory configuration and generated integration ([#161](https://github.com/salimhamed/jigs/issues/161)) ([fdd0cca](https://github.com/salimhamed/jigs/commit/fdd0ccaa7e79aee3c8b011956f50425705a235c7))

## [0.7.0](https://github.com/salimhamed/jigs/compare/jigs-v0.6.0...jigs-v0.7.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* post plain-language needs-human comments ([#158](https://github.com/salimhamed/jigs/issues/158))

### Features

* post plain-language needs-human comments ([#158](https://github.com/salimhamed/jigs/issues/158)) ([113dbc4](https://github.com/salimhamed/jigs/commit/113dbc436825a13265a98360ef44926a9d3180ad))

## [0.6.0](https://github.com/salimhamed/jigs/compare/jigs-v0.5.0...jigs-v0.6.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* prompts are typed functions a factory can pass to a block ([#157](https://github.com/salimhamed/jigs/issues/157))

### Features

* prompts are typed functions a factory can pass to a block ([#157](https://github.com/salimhamed/jigs/issues/157)) ([c63eee9](https://github.com/salimhamed/jigs/commit/c63eee9d2d3e523313aa7b95997c552d4847632d))

## [0.5.0](https://github.com/salimhamed/jigs/compare/jigs-v0.4.5...jigs-v0.5.0) (2026-09-11)


### ⚠ BREAKING CHANGES

* publish two import paths, blocks and steps ([#151](https://github.com/salimhamed/jigs/issues/151))

### Features

* publish two import paths, blocks and steps ([#151](https://github.com/salimhamed/jigs/issues/151)) ([2e8c5a3](https://github.com/salimhamed/jigs/commit/2e8c5a3dc54a67952b999fc1a97180cbad7e9dc9))

## [0.4.5](https://github.com/salimhamed/jigs/compare/jigs-v0.4.4...jigs-v0.4.5) (2026-09-10)


### Bug Fixes

* acknowledge unmatched deliveries, check the Linear webhook ([#147](https://github.com/salimhamed/jigs/issues/147)) ([37092a9](https://github.com/salimhamed/jigs/commit/37092a9486dfc466134f13490a203be17fb7ad4c))

## [0.4.4](https://github.com/salimhamed/jigs/compare/jigs-v0.4.3...jigs-v0.4.4) (2026-09-10)


### Bug Fixes

* match github webhooks by exact url and check them in doctor ([#146](https://github.com/salimhamed/jigs/issues/146)) ([b5544fc](https://github.com/salimhamed/jigs/commit/b5544fc5da864c54a5ba1d72532230fdfe26187a))

## [0.4.3](https://github.com/salimhamed/jigs/compare/jigs-v0.4.2...jigs-v0.4.3) (2026-09-07)


### Bug Fixes

* **sweep:** delete a redundant branch however the run ended ([#138](https://github.com/salimhamed/jigs/issues/138)) ([3d92c96](https://github.com/salimhamed/jigs/commit/3d92c96cd845db48cff4f9cbc90a3b84ab3a090b))

## [0.4.2](https://github.com/salimhamed/jigs/compare/jigs-v0.4.1...jigs-v0.4.2) (2026-09-07)


### Bug Fixes

* **providers:** see CI that reports commit statuses, not just checks ([#139](https://github.com/salimhamed/jigs/issues/139)) ([15b114a](https://github.com/salimhamed/jigs/commit/15b114a5dd8ffcc960975e0724186bca9e1443e4))

## [0.4.1](https://github.com/salimhamed/jigs/compare/jigs-v0.4.0...jigs-v0.4.1) (2026-09-07)


### Bug Fixes

* **init:** ports are a starting point the operator can change ([#134](https://github.com/salimhamed/jigs/issues/134)) ([67b3dbc](https://github.com/salimhamed/jigs/commit/67b3dbcf9f51d786d86e7cc35a65c2cc5efff7f3))

## [0.4.0](https://github.com/salimhamed/jigs/compare/jigs-v0.3.0...jigs-v0.4.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* ship building blocks, not compositions ([#121](https://github.com/salimhamed/jigs/issues/121))

### Features

* ship building blocks, not compositions ([#121](https://github.com/salimhamed/jigs/issues/121)) ([3411238](https://github.com/salimhamed/jigs/commit/34112389ca75d3dba99bf64409dfb80989c58971))

## [0.3.0](https://github.com/salimhamed/jigs/compare/jigs-v0.2.0...jigs-v0.3.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* ship jigs as a single package ([#110](https://github.com/salimhamed/jigs/issues/110))

### Features

* ship jigs as a single package ([#110](https://github.com/salimhamed/jigs/issues/110)) ([e84c6c7](https://github.com/salimhamed/jigs/commit/e84c6c7507d36ed663ccd72a4f1981ee9ebf79c3))

## [0.2.0](https://github.com/salimhamed/jigs/compare/jigs-v0.1.20...jigs-v0.2.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* publish as @salimhamed/jigs and @salimhamed/jigs-service ([#101](https://github.com/salimhamed/jigs/issues/101))

### Features

* **jigs:** add jigs upgrade to bump both packages, run up, then typecheck ([#100](https://github.com/salimhamed/jigs/issues/100)) ([c206de1](https://github.com/salimhamed/jigs/commit/c206de17feabba2c1479e392ff745575f1f7d36f))
* publish as @salimhamed/jigs and @salimhamed/jigs-service ([#101](https://github.com/salimhamed/jigs/issues/101)) ([b3887ce](https://github.com/salimhamed/jigs/commit/b3887ceced8d4b0053be814debae90f9df304cb7))


### Bug Fixes

* green main after the publish rename (e2e lockfile, upgrade test) ([#106](https://github.com/salimhamed/jigs/issues/106)) ([f6eed04](https://github.com/salimhamed/jigs/commit/f6eed04e025efbfaec321afa459edcc19f491495))

## [0.1.20](https://github.com/salimhamed/jigs/compare/jigs-v0.1.19...jigs-v0.1.20) (2026-09-06)


### Bug Fixes

* **service:** exit cleanly on SIGTERM and wait for /health on start ([#91](https://github.com/salimhamed/jigs/issues/91)) ([257521e](https://github.com/salimhamed/jigs/commit/257521ecf8eb253abd572cd9cfe9715a110817bc))

## [0.1.19](https://github.com/salimhamed/jigs/compare/jigs-v0.1.18...jigs-v0.1.19) (2026-09-06)


### Features

* **jigs:** init scaffolds the factory code and e2e builds the scaffold ([#95](https://github.com/salimhamed/jigs/issues/95)) ([a8f1e1b](https://github.com/salimhamed/jigs/commit/a8f1e1b7d835c2a736a2c8d6c3161e45b0ab2d65))

## [0.1.18](https://github.com/salimhamed/jigs/compare/jigs-v0.1.17...jigs-v0.1.18) (2026-09-06)


### Features

* **jigs:** add jigs up to take a factory from any state to a running service ([#90](https://github.com/salimhamed/jigs/issues/90)) ([e8a979d](https://github.com/salimhamed/jigs/commit/e8a979d7de072dfc3872ab553e9d4105eb0c3083))
* **jigs:** ship templates inside the CLI and version-pin the scaffold ([#86](https://github.com/salimhamed/jigs/issues/86)) ([3d71ff0](https://github.com/salimhamed/jigs/commit/3d71ff0e6a5b374f1d318af6044cc774493fe505))

## [0.1.17](https://github.com/salimhamed/jigs/compare/jigs-v0.1.16...jigs-v0.1.17) (2026-09-05)


### Features

* **service:** clone every binding at start and simplify the clone to four idempotent steps ([#78](https://github.com/salimhamed/jigs/issues/78)) ([555f9ab](https://github.com/salimhamed/jigs/commit/555f9ab429eb480b4086ba997097c36b3dae5fdf))

## [0.1.16](https://github.com/salimhamed/jigs/compare/jigs-v0.1.15...jigs-v0.1.16) (2026-09-05)


### Features

* **bindings:** describe worktree provisioning on the binding, drop .jigs.yml and the seed directory ([#76](https://github.com/salimhamed/jigs/issues/76)) ([500d079](https://github.com/salimhamed/jigs/commit/500d079cf8175445ae95db611b859a69285b918c))

## [0.1.15](https://github.com/salimhamed/jigs/compare/jigs-v0.1.14...jigs-v0.1.15) (2026-09-05)


### Bug Fixes

* **worktrees:** fail loudly on a stale registry, prune merged tracking refs, and harden git calls ([#74](https://github.com/salimhamed/jigs/issues/74)) ([f9350d9](https://github.com/salimhamed/jigs/commit/f9350d948dd2a36a455a96bb5a3445f4fe9d599f))

## [0.1.14](https://github.com/salimhamed/jigs/compare/jigs-v0.1.13...jigs-v0.1.14) (2026-09-05)


### Features

* add the /jigs skill and a README for new users ([#69](https://github.com/salimhamed/jigs/issues/69)) ([7013c37](https://github.com/salimhamed/jigs/commit/7013c374a4680b76acd469369ed9b4093dd8dfac))

## [0.1.13](https://github.com/salimhamed/jigs/compare/jigs-v0.1.12...jigs-v0.1.13) (2026-09-04)


### Features

* **service:** host the run dashboard and surface stalled runs ([#67](https://github.com/salimhamed/jigs/issues/67)) ([b9d8655](https://github.com/salimhamed/jigs/commit/b9d8655a94d5cfb1533744b6b1275f17267ea8cb))

## [0.1.12](https://github.com/salimhamed/jigs/compare/jigs-v0.1.11...jigs-v0.1.12) (2026-09-04)


### Features

* **service:** fire pipelines on a recurring schedule ([#65](https://github.com/salimhamed/jigs/issues/65)) ([de21f8b](https://github.com/salimhamed/jigs/commit/de21f8b7e416ab259738d9d10b8e1e802e2ef6cb))

## [0.1.11](https://github.com/salimhamed/jigs/compare/jigs-v0.1.10...jigs-v0.1.11) (2026-09-04)


### Miscellaneous Chores

* **jigs:** Synchronize jigs versions

## [0.1.10](https://github.com/salimhamed/jigs/compare/jigs-v0.1.9...jigs-v0.1.10) (2026-09-04)


### Features

* **checks:** preflight AWS credentials when a pipeline requires them ([#61](https://github.com/salimhamed/jigs/issues/61)) ([078fb68](https://github.com/salimhamed/jigs/commit/078fb68006805ae94cba3a0ae05ef0b5604046cd))

## [0.1.9](https://github.com/salimhamed/jigs/compare/jigs-v0.1.8...jigs-v0.1.9) (2026-08-31)


### Miscellaneous Chores

* **jigs:** Synchronize jigs versions

## [0.1.8](https://github.com/salimhamed/jigs/compare/jigs-v0.1.7...jigs-v0.1.8) (2026-08-31)


### Bug Fixes

* lead needs-human findings with an answerable question ([#56](https://github.com/salimhamed/jigs/issues/56)) ([aed6504](https://github.com/salimhamed/jigs/commit/aed6504acbc044f30810139f496e460b147f4580))

## [0.1.7](https://github.com/salimhamed/jigs/compare/jigs-v0.1.6...jigs-v0.1.7) (2026-08-31)


### Miscellaneous Chores

* **jigs:** Synchronize jigs versions

## [0.1.6](https://github.com/salimhamed/jigs/compare/jigs-v0.1.5...jigs-v0.1.6) (2026-08-31)


### Miscellaneous Chores

* **jigs:** Synchronize jigs versions

## [0.1.5](https://github.com/salimhamed/jigs/compare/jigs-v0.1.4...jigs-v0.1.5) (2026-08-31)


### Features

* let step self-invocations wait forever and scope the ceiling to them ([#49](https://github.com/salimhamed/jigs/issues/49)) ([eb52bb6](https://github.com/salimhamed/jigs/commit/eb52bb668655c48da97c094c7b35382ce2faa645))

## [0.1.4](https://github.com/salimhamed/jigs/compare/jigs-v0.1.3...jigs-v0.1.4) (2026-08-31)


### Features

* launch and address runs by their Linear ticket identifier ([#46](https://github.com/salimhamed/jigs/issues/46)) ([ec2b293](https://github.com/salimhamed/jigs/commit/ec2b293416fbcfb372fb0d18f6cfa0434e0456c3))

## [0.1.3](https://github.com/salimhamed/jigs/compare/jigs-v0.1.2...jigs-v0.1.3) (2026-08-31)


### Bug Fixes

* run codex unsandboxed so builders can commit in git worktrees ([#43](https://github.com/salimhamed/jigs/issues/43)) ([e3ad6f9](https://github.com/salimhamed/jigs/commit/e3ad6f95bad31d5801b316a644fbe713c5a3638f))

## [0.1.2](https://github.com/salimhamed/jigs/compare/jigs-v0.1.1...jigs-v0.1.2) (2026-08-31)


### Bug Fixes

* recover the review loop when the builder finishes without committing ([#41](https://github.com/salimhamed/jigs/issues/41)) ([bb79ea2](https://github.com/salimhamed/jigs/commit/bb79ea2b699b919c2e783c1ca0ed7034423235dd))

## [0.1.1](https://github.com/salimhamed/jigs/compare/jigs-v0.1.0...jigs-v0.1.1) (2026-08-31)


### Features

* automate releases and hand PR presentation to factories ([#36](https://github.com/salimhamed/jigs/issues/36)) ([d2ceafd](https://github.com/salimhamed/jigs/commit/d2ceafd19c46932b72bea12f9251f3198cfdab1f))

---

## Folded in from @salimhamed/jigs-service

The service shipped as a second package through 0.2.0, released in lockstep
with this one, and its changelog is gone with it. Every entry the two shared
is already above; these are the ones only the service's carried.

### Features

* **service:** find a Linear issue in a project by title prefix ([#63](https://github.com/salimhamed/jigs/issues/63)) ([ae59b31](https://github.com/salimhamed/jigs/commit/ae59b315ff3ff6e5ed7a99ff12b54474cddb79c3)) — 0.1.11
* **service:** log ticket review, worktree, and snapshot milestones ([#58](https://github.com/salimhamed/jigs/issues/58)) ([4edd6e9](https://github.com/salimhamed/jigs/commit/4edd6e9ca1a789b69d5710b9bcd8253d196e6db0)) — 0.1.9

### Bug Fixes

* **service:** never mint a ticket token from a missing segment ([#54](https://github.com/salimhamed/jigs/issues/54)) ([6ecf98a](https://github.com/salimhamed/jigs/commit/6ecf98ae7c56098217b675fbbc1a935cc0f943ba)) — 0.1.7
* **service:** log an outcome line for every ingress delivery ([#52](https://github.com/salimhamed/jigs/issues/52)) ([2398937](https://github.com/salimhamed/jigs/commit/2398937c7a94daf854a790187bc13284e2805c6a)) — 0.1.6
* **service:** render needs-human comments as prose ([#51](https://github.com/salimhamed/jigs/issues/51)) ([c820ec5](https://github.com/salimhamed/jigs/commit/c820ec52f77c7dda0d8a28a567014ab7af3629b0)) — 0.1.5
* answer the operator's review comments on personal-token factories ([#48](https://github.com/salimhamed/jigs/issues/48)) ([e6fea24](https://github.com/salimhamed/jigs/commit/e6fea2403287ba23cb132c15b5d197469138e61d)) — 0.1.5
