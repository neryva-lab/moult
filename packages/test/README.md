# @moult/test

Public test-host utilities for proving Moult ownership, replacement, disposal,
and leak behavior.

## Installation

```bash
npm install --save-dev @moult/test @moult/runtime
```

Requires Node.js 22 or newer.

## Example

The test kit uses only the public runtime API and makes resource ownership
observable without reading runtime internals.

```ts
import { capability } from '@moult/runtime';
import { expectGenerationDisposed, fakeResources, pluginHarness } from '@moult/test';

const resources = fakeResources();
const ready = capability<{ readonly ok: true }>('example.ready', '1.0.0');
const harness = pluginHarness({
  id: 'example.plugin',
  version: '1.0.0',
  provides: [{ capability: ready }],
  setup: async (context) => {
    const connection = resources.connectionHost();
    await context.scope.acquire(connection.create, connection.dispose);
    context.provide(ready, { ok: true });
  },
});

await harness.run();
await harness.dispose();
await expectGenerationDisposed(harness.runtime, 'example.plugin');
resources.expectNoLeaks();
```

## Features

- `fakeResources` creates observable connections, listeners, timers, and
  failing resources.
- `pluginHarness` runs setup-level tests against the public runtime contract.
- `expectGenerationDisposed` verifies that a generation is no longer retained.
- `resources.expectNoLeaks()` verifies that all tracked resources were released.
- Failure cues make resource creation and disposal deterministic.

This is a development and test package. It does not provide lifecycle
behavior for production applications and does not import Moult internals.

## Public API

The package exports `fakeResources`, `pluginHarness`,
`expectGenerationDisposed`, and the public fake-resource and harness types.

## Status and documentation

Implemented and packaged at `0.1.1`; publication is pending. See the
[Moult repository](https://github.com/neryva-lab/moult), the
[adapter design](https://github.com/neryva-lab/moult/blob/main/docs/notes/05-adapters-and-host-integration.md),
and the [lifecycle guarantees](https://github.com/neryva-lab/moult/blob/main/docs/guarantees.md).
