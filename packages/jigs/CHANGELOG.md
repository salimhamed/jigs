# Changelog

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
