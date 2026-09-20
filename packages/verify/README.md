# @moult/verify

Static contract linter for Moult plugin definitions and plugin graphs. It checks the statically checkable subset of the [replaceable-plugin contract](./CONTRACT.md) without executing any code and without importing `@moult/runtime` — so it runs in editors, CI, and code-generation pipelines.

## Install

```sh
pnpm add -D @moult/verify
```

Node 22+.

## Usage

```ts
import { verifyDefinition, verifyGraph } from '@moult/verify';

const issues = verifyDefinition({
  id: 'acme.storage',
  version: '1.2.3',
  setup: (ctx) => {
    ctx.provide(storageCapability, new Storage());
  },
  provides: [{ capability: storageCapability }],
  requires: [{ capability: logCapability, range: '^1.0.0' }],
});

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`${issue.code} (${issue.path ?? '<root>'}): ${issue.message}`);
  }
  process.exit(1);
}
```

Check a whole graph for cross-definition conflicts (duplicate plugin ids, ambiguous single-provider capability claims):

```ts
import { verifyGraph } from '@moult/verify';

const issues = verifyGraph([storageDefinition, cacheDefinition, apiDefinition]);
```

## API

### `verifyDefinition(definition: unknown): VerifyIssue[]`

Lints one definition. Pure and side-effect free — hooks are never executed. Returns issues in a deterministic order (field order, then array order); an empty array means statically clean.

Checks:

- `id`: required, must match the runtime id grammar — dot-separated segments, each starting with a lowercase letter followed by lowercase letters, digits, or hyphens (mirrors `isValidRuntimeId` in `@moult/runtime`).
- `version`: required, must be valid semver.
- `setup`: required, must be a function.
- `provides` / `requires`: arrays when present. Each `provides` entry needs `capability: { id, version }` with a valid id and semver version; `multiple` must be a boolean when present; no duplicate capability ids within one definition. Each `requires` entry needs `capability: { id }` with a valid id; `range` must be a valid semver range when present; `optional` must be a boolean when present; no duplicate requirements. A plugin may not both require and provide the same capability.
- `config`: must be a plain record when present.
- `stateVersion`: must be a string or number when present.
- Hooks (`validateConfig`, `migrate`, `drain`, `healthCheck`): must be functions when present.
- Unknown top-level fields produce an `unknown-field` **advisory**, never an error — the runtime ignores fields it does not know, and failing closed would reject forward-compatible definitions.

### `verifyGraph(definitions: readonly unknown[]): VerifyIssue[]`

Runs `verifyDefinition` on each entry, then cross-definition checks:

- `duplicate-plugin-id` — two definitions share a plugin id (the runtime rejects the second install with `DUPLICATE_PLUGIN`).
- `ambiguous-provider` — the same capability id is claimed by two definitions where either claim is not `multiple: true` (the runtime rejects this with `AMBIGUOUS_PROVIDER`). Claims where **both** sides are `multiple: true` are exempt.

### `VerifyIssue`

```ts
interface VerifyIssue {
  readonly code: string; // stable, e.g. 'invalid-id', 'duplicate-capability'
  readonly message: string; // human-readable
  readonly path?: string | undefined; // e.g. 'provides[0].capability.id'
}
```

Issue codes are additive: new linter versions may add codes but never change the meaning of an existing one.

## What this linter cannot check

Static analysis sees shapes, not behavior. The dynamic half of the contract — disposal actually releasing resources, `healthCheck` being side-effect free, no cross-generation object capture — is documented in [CONTRACT.md](./CONTRACT.md) and enforced at runtime by the lifecycle engine (scope disposal, timeouts, the health gate), not here.

## License

MIT
