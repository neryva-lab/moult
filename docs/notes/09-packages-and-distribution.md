# 09 — Packages and Distribution

How Moult is published as scoped `@moult/*` packages, how it mirrors the TanStack/Effect pattern, and how to add a new framework adapter without confusion. This note is the authority for `what is publishable`; package manifests, tests, and CI implement it.

## 1. Current publishable set

After the SQLite hard-delete (`packages/sqlite` removed, `pnpm-lock.yaml` importer deleted), the monorepo contains **5** publishable packages. The initial release was versioned at `0.1.0`; the documentation patch release (`0.1.1`) went through the normal Changesets version flow; publication remains gated by the release checklist:

| Package          | Directory               | Published?                                   | `peerDependencies`                                                                   |
| ---------------- | ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@moult/runtime` | `packages/runtime-core` | Yes — core                                   | `semver ^7.8.5` is the only `dependencies` (`packages/runtime-core/package.json:49`) |
| `@moult/test`    | `packages/test`         | Yes — support, ships with core               | `peer: @moult/runtime workspace:*`                                                   |
| `@moult/events`  | `packages/events`       | Yes — adapter (demo of scoped subscriptions) | `peer: @moult/runtime workspace:*`                                                   |
| `@moult/react`   | `packages/react`        | Yes — adapter                                | `peer: @moult/runtime workspace:*, react >=18` (`packages/react/package.json:49`)    |
| `@moult/vite`    | `packages/vite`         | Yes — adapter (headline HMR demo)            | `peer: @moult/runtime workspace:*`                                                   |

Verifier: `pnpm-workspace.yaml:1` `packages: ['packages/*','examples/*','demo/*']` discovers the 5 dirs; the initial Changesets versioning pass covered the same 5 packages; and `.github/workflows/release.yml` asserts that five package tarballs are produced.

`examples/command-host`, `examples/worker-host`, `demo/comparison`, `demo/browser-smoke` are `private` workspaces — never published (` .changeset/config.json:10` `ignore: [...]`).

## 2. How top libraries do the same

The distribution pattern is comparable to established core-plus-adapter
monorepos, but package counts, star counts, dependency fields, and publishing
behavior change over time. Recheck the upstream documentation before using
these comparisons as release evidence:

- **[TanStack Query](https://github.com/TanStack/query)** separates a framework-neutral core from framework adapters and uses peer dependencies for framework integrations.
- **[Effect](https://github.com/Effect-TS/effect)** distributes a core with platform and framework-specific packages in one workspace.

Moult follows the same: `1 core + N adapters` under `@moult/*`, `pnpm workspace + changesets`, `files: ["dist","README.md","LICENSE"]`, `exports: {".": {import/require}}`, `sideEffects: false`, `publishConfig.access: public`.

## 3. Installation for users

Users install **only** what their host needs — adapters never pull an unwanted framework:

```bash
pnpm add @moult/runtime                          # any host (no React/Vite)
pnpm add @moult/runtime @moult/events             # + scoped events
pnpm add @moult/runtime @moult/react react        # React host
pnpm add @moult/runtime @moult/vite               # Vite HMR host
pnpm add @moult/runtime @moult/react @moult/vite   # React + Vite
pnpm add @moult/runtime @moult/test -D            # tests only
```

Future: `pnpm add @moult/runtime @moult/vue vue` will work the same way.

Why `peer` instead of `dependencies` for `@moult/runtime`? Users call
`createRuntime()` directly from `@moult/runtime`, so the runtime is a direct
user dependency. Using `peer: @moult/runtime workspace:*` requires the app to
declare the runtime version once and avoids duplicate runtime instances.
Changesets rewrites the workspace range during publication. Keeping `peer` is
intentional; changing adapters to runtime dependencies would trade explicit
core ownership for single-install convenience.

## 4. Adapter contract (what makes an adapter publishable)

Every adapter in `docs/notes/05-adapters-and-host-integration.md:24` must satisfy:

1. **Charter** — the package's problem is stated in [note 05](./05-adapters-and-host-integration.md). No charter = not published.
2. **Core never imports adapter** — `.cruiser.json:29` `adapters-depend-on-core-only: from ^packages/(test|events|react|vite)/src/ -> packages/* pathNot runtime-core`. Adding `vue` requires updating that regex to `...|vue`.
3. **Package manifest** — every published package uses dual ESM/CJS output, conditional `exports` types, `files: ["dist","README.md","LICENSE"]`, `sideEffects: false`, `engines: node >=22`, and `publishConfig.access: public`. Adapters add `peerDependencies: {"@moult/runtime":"workspace:*", "<framework>": ">=..."}` and keep runtime `dependencies` empty.
4. **Build** — `packages/<name>/tsdown.config.ts: platform: node, deps.neverBundle: ['@moult/runtime']`, `tsconfig.json: extends ../../tsconfig.tests.json`.
5. **API review** — `api-extractor.json`, `etc/api/<name>.api.md` committed, `pnpm check:api` green.
6. **Tests** — package Vitest projects prove failure behavior and use `expectNoLeaks()` where resources are involved; forced failures must preserve the public guarantees.

Persistence (`database.connection`, `sql`, `indexedDB`) is **host-owned**, not a package — core already guarantees `INV-12` via `Scope`, and `docs/notes/01-thesis-and-boundaries.md:51` lists `database engine` as a deliberate non-goal. `packages/sqlite` was removed for that reason.

## 5. How to add a new framework (e.g., `@moult/vue`)

Copy this checklist — no other steps are required:

1.  `mkdir packages/vue && cp packages/events/package.json packages/vue/` — edit `name: @moult/vue`, `description: Vue adapter...`, `peerDependencies: {"@moult/runtime":"workspace:*","vue":">=3"}`.
2.  `src/index.ts` — implement adapter using only `import { capability, MoltError } from '@moult/runtime'` and `Scope`; never import `packages/runtime-core/src/internal`.
3.  `tsdown.config.ts`, `tsconfig.json`, `vitest.config.ts`, `api-extractor.json`, `.prettierignore` — copy from `packages/events`.
4.  `README.md` — state problem solved (e.g., `Vue contributions unmount when generation disposed`).
5.  `.cruiser.json:32` — `^packages/(test|events|react|vite|vue)/src/`.
6.  `package.json:26,28` — add `&& pnpm --filter @moult/vue test` to `test:adapters` and `&& pnpm --filter @moult/vue exec publint` / `exec attw` to `check:pkg`.
7.  `docs/notes/05-adapters-and-host-integration.md:10` — add `vue/` to the boundary + diagram `host -> vue -> runtime-core`.
8.  Add `vue/ # @moult/vue` to the workspace and package documentation.
9.  Add the adapter's problem, behavior, failure tests, and public API documentation.
10. Add the corresponding maintainer-only release task and evidence entry.
11. `README.md:91` — add `| @moult/vue | ... |` row.
12. `.changeset/pending-vue.md` — `---\n'@moult/vue': minor\n---`.
13. Update the release workflow's package-count assertion, or replace it with a `publishConfig.access` filter.
14. `pnpm install && pnpm build && pnpm check:arch && pnpm check:pkg && pnpm check:api && pnpm test:adapters` — all green before PR.

No core file changes, no new `dependencies` in core, no global registry.

## 6. Publishing (Changesets + OIDC)

- Versioning: `pnpm changeset` creates `.changeset/*.md`; `pnpm changeset version` bumps `packages/*/package.json` and adds `publishConfig.access` handling; `pnpm changeset publish` publishes only packages with `publishConfig.access: public` and `version !== 0.0.0`.
- Dry run: the release workflow packs each publishable package and asserts that five package tarballs are produced. If an internal `packages/internal-*` is added, switch to an explicit allowlist or `jq '.publishConfig.access=="public"'` filter (review note on hard-delete PR).
- Provenance: the release workflow uses the `npm-release` environment and `NPM_CONFIG_PROVENANCE: true`; it does not use a long-lived token.

## 7. What not to do

- Do not add `runtime-sqlite`/`runtime-db`/`runtime-electron` as a public package unless two independent hosts need it — it violates `internal first` charter and the host-owned persistence rule that removed `sqlite`.
- Do not change `strict`, `exactOptionalPropertyTypes`, or `verbatimModuleSyntax`, and do not add a runtime dependency to core beyond its documented `semver` dependency.
- Do not let adapters import each other (`events` -> `react` forbidden by cruiser).
