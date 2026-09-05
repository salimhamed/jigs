# Changelog

## [0.1.17](https://github.com/salimhamed/jigs/compare/service-v0.1.16...service-v0.1.17) (2026-09-05)


### Features

* **service:** clone every binding at start and simplify the clone to four idempotent steps ([#78](https://github.com/salimhamed/jigs/issues/78)) ([555f9ab](https://github.com/salimhamed/jigs/commit/555f9ab429eb480b4086ba997097c36b3dae5fdf))

## [0.1.16](https://github.com/salimhamed/jigs/compare/service-v0.1.15...service-v0.1.16) (2026-09-05)


### Features

* **bindings:** describe worktree provisioning on the binding, drop .jigs.yml and the seed directory ([#76](https://github.com/salimhamed/jigs/issues/76)) ([500d079](https://github.com/salimhamed/jigs/commit/500d079cf8175445ae95db611b859a69285b918c))

## [0.1.15](https://github.com/salimhamed/jigs/compare/service-v0.1.14...service-v0.1.15) (2026-09-05)


### Bug Fixes

* **worktrees:** fail loudly on a stale registry, prune merged tracking refs, and harden git calls ([#74](https://github.com/salimhamed/jigs/issues/74)) ([f9350d9](https://github.com/salimhamed/jigs/commit/f9350d948dd2a36a455a96bb5a3445f4fe9d599f))

## [0.1.14](https://github.com/salimhamed/jigs/compare/service-v0.1.13...service-v0.1.14) (2026-09-05)


### Miscellaneous Chores

* **service:** Synchronize jigs versions

## [0.1.13](https://github.com/salimhamed/jigs/compare/service-v0.1.12...service-v0.1.13) (2026-09-04)


### Features

* **service:** host the run dashboard and surface stalled runs ([#67](https://github.com/salimhamed/jigs/issues/67)) ([b9d8655](https://github.com/salimhamed/jigs/commit/b9d8655a94d5cfb1533744b6b1275f17267ea8cb))

## [0.1.12](https://github.com/salimhamed/jigs/compare/service-v0.1.11...service-v0.1.12) (2026-09-04)


### Features

* **service:** fire pipelines on a recurring schedule ([#65](https://github.com/salimhamed/jigs/issues/65)) ([de21f8b](https://github.com/salimhamed/jigs/commit/de21f8b7e416ab259738d9d10b8e1e802e2ef6cb))

## [0.1.11](https://github.com/salimhamed/jigs/compare/service-v0.1.10...service-v0.1.11) (2026-09-04)


### Features

* **service:** find a Linear issue in a project by title prefix ([#63](https://github.com/salimhamed/jigs/issues/63)) ([ae59b31](https://github.com/salimhamed/jigs/commit/ae59b315ff3ff6e5ed7a99ff12b54474cddb79c3))

## [0.1.10](https://github.com/salimhamed/jigs/compare/service-v0.1.9...service-v0.1.10) (2026-09-04)


### Miscellaneous Chores

* **service:** Synchronize jigs versions

## [0.1.9](https://github.com/salimhamed/jigs/compare/service-v0.1.8...service-v0.1.9) (2026-08-31)


### Features

* **service:** log ticket review, worktree, and snapshot milestones ([#58](https://github.com/salimhamed/jigs/issues/58)) ([4edd6e9](https://github.com/salimhamed/jigs/commit/4edd6e9ca1a789b69d5710b9bcd8253d196e6db0))

## [0.1.8](https://github.com/salimhamed/jigs/compare/service-v0.1.7...service-v0.1.8) (2026-08-31)


### Bug Fixes

* lead needs-human findings with an answerable question ([#56](https://github.com/salimhamed/jigs/issues/56)) ([aed6504](https://github.com/salimhamed/jigs/commit/aed6504acbc044f30810139f496e460b147f4580))

## [0.1.7](https://github.com/salimhamed/jigs/compare/service-v0.1.6...service-v0.1.7) (2026-08-31)


### Bug Fixes

* **service:** never mint a ticket token from a missing segment ([#54](https://github.com/salimhamed/jigs/issues/54)) ([6ecf98a](https://github.com/salimhamed/jigs/commit/6ecf98ae7c56098217b675fbbc1a935cc0f943ba))

## [0.1.6](https://github.com/salimhamed/jigs/compare/service-v0.1.5...service-v0.1.6) (2026-08-31)


### Bug Fixes

* **service:** log an outcome line for every ingress delivery ([#52](https://github.com/salimhamed/jigs/issues/52)) ([2398937](https://github.com/salimhamed/jigs/commit/2398937c7a94daf854a790187bc13284e2805c6a))

## [0.1.5](https://github.com/salimhamed/jigs/compare/service-v0.1.4...service-v0.1.5) (2026-08-31)


### Features

* let step self-invocations wait forever and scope the ceiling to them ([#49](https://github.com/salimhamed/jigs/issues/49)) ([eb52bb6](https://github.com/salimhamed/jigs/commit/eb52bb668655c48da97c094c7b35382ce2faa645))


### Bug Fixes

* answer the operator's review comments on personal-token factories ([#48](https://github.com/salimhamed/jigs/issues/48)) ([e6fea24](https://github.com/salimhamed/jigs/commit/e6fea2403287ba23cb132c15b5d197469138e61d))
* **service:** render needs-human comments as prose ([#51](https://github.com/salimhamed/jigs/issues/51)) ([c820ec5](https://github.com/salimhamed/jigs/commit/c820ec52f77c7dda0d8a28a567014ab7af3629b0))

## [0.1.4](https://github.com/salimhamed/jigs/compare/service-v0.1.3...service-v0.1.4) (2026-08-31)


### Features

* launch and address runs by their Linear ticket identifier ([#46](https://github.com/salimhamed/jigs/issues/46)) ([ec2b293](https://github.com/salimhamed/jigs/commit/ec2b293416fbcfb372fb0d18f6cfa0434e0456c3))

## [0.1.3](https://github.com/salimhamed/jigs/compare/service-v0.1.2...service-v0.1.3) (2026-08-31)


### Miscellaneous Chores

* **service:** Synchronize jigs versions

## [0.1.2](https://github.com/salimhamed/jigs/compare/service-v0.1.1...service-v0.1.2) (2026-08-31)


### Bug Fixes

* recover the review loop when the builder finishes without committing ([#41](https://github.com/salimhamed/jigs/issues/41)) ([bb79ea2](https://github.com/salimhamed/jigs/commit/bb79ea2b699b919c2e783c1ca0ed7034423235dd))

## [0.1.1](https://github.com/salimhamed/jigs/compare/service-v0.1.0...service-v0.1.1) (2026-08-31)


### Features

* automate releases and hand PR presentation to factories ([#36](https://github.com/salimhamed/jigs/issues/36)) ([d2ceafd](https://github.com/salimhamed/jigs/commit/d2ceafd19c46932b72bea12f9251f3198cfdab1f))
