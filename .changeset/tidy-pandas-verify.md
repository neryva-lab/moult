---
'@moult/verify': minor
---

Add `@moult/verify`: a static contract linter for Moult plugin definitions and plugin graphs. `verifyDefinition` checks the statically checkable subset of the replaceable-plugin contract (id grammar, semver versions and ranges, provides/requires shapes, hook types, config records) without executing any code or importing `@moult/runtime`; `verifyGraph` adds cross-definition checks for duplicate plugin ids and ambiguous single-provider capability claims. Ships with `CONTRACT.md`, documenting the full replaceable-plugin contract including the behavioral half enforced at runtime.
