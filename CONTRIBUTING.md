# Contributing to Moult

Thank you for contributing. Moult is a plugin runtime whose value is its failure behavior, so this repository has unusually hard rules — they exist because every one of them guards a guarantee, not a preference. Read [`docs/notes/`](./docs/notes/README.md) for the design and [`docs/guarantees.md`](./docs/guarantees.md) for the public lifecycle contract.

## Setup

Two commands, from a fresh clone:

```bash
pnpm install
pnpm verify
```

`pnpm verify` runs typecheck, lint, and dead-code hygiene across all packages and must pass before you change anything else. Requires Node ≥ 22 (Node 20 is end-of-life and unsupported).

## Maintainer planning

The detailed implementation plan, release evidence, and task ledger are
maintainer work documents. They are kept outside the published repository so
the public tree contains stable user and contributor documentation rather than
in-progress execution artifacts.

## The PR checklist

Every pull request states three things:

1. **What changed** — one paragraph, plain language.
2. **Which invariants it touches** — use the public registry in [`docs/guarantees.md`](./docs/guarantees.md). If your change could affect lifecycle behavior, name the invariants and the tests that re-prove them.
3. **Which checks prove it** — list the relevant package scripts and CI checks, with results.

Additionally:

- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- If your change invalidates a design note or an agent skill, update it **in the same PR**. The notes and the code must never diverge silently.
- `main` is protected: required checks, linear history, no admin override for red checks.

## The non-negotiables

From the ground rules — a PR violating any of these is rejected regardless of what it adds:

- No stubs: no `TODO` in place of behavior, no empty branches, no unexported-but-claimed capabilities.
- Core throws only `MoltError` with a code from the fixed set; never `console.*`; no `any`; no non-null assertions; no default exports in packages.
- `runtime-core` has exactly one runtime dependency (`semver`) and imports no browser, UI, or database module.
- Tests are named after the invariant they prove (`INV-07: …`) and assert behavior through public API, observers, inspection, or test-kit counters — never private state.
- A failed replacement leaves the old generation active and usable. This is the product. Do not simplify it.

## Reporting problems

- Bugs and feature requests: GitHub issues (templates provided).
- Lifecycle semantics behaving differently than documented: use the **"Lifecycle semantics"** issue template and name the invariant (INV-xx) — this category is first-class in this project.
- Security: see [`SECURITY.md`](./SECURITY.md). Note that Moult's core is an orchestration and ownership library, not a sandbox — that classification matters for reports.
