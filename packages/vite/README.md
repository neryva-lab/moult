# @moult/vite

Vite HMR bindings that map module updates to Moult lifecycle operations.

## Installation

```bash
npm install @moult/vite @moult/runtime vite
```

Requires Node.js 22 or newer. The host supplies the Vite HMR event source.

## Example

The bridge delegates installation, replacement, and removal to the runtime.
Import and setup failures therefore preserve the previous active generation.

```ts
import { createRuntime } from '@moult/runtime';
import { createViteBridge, type ViteHotSource } from '@moult/vite';

const runtime = createRuntime();
const hot = import.meta.hot as unknown as ViteHotSource | undefined;

if (hot !== undefined) {
  createViteBridge({
    runtime,
    hot,
  });
}
```

## Features

- Handles `added`, `changed`, and `removed` module events.
- Maps events to `Runtime.install`, `Runtime.replace`, and
  `Runtime.uninstall`.
- Loads replacement definitions before invoking the replacement transaction.
- Keeps the old generation active when import or setup fails.
- Serializes updates through the runtime lifecycle engine.
- Reports structured failures through the optional diagnostic callback.
- Keeps Vite module-graph objects outside the core runtime.

The host owns the HMR event source and decides how diagnostics are displayed.
The bridge does not implement a second lifecycle or replacement protocol.

## Public API

The package exports `createViteBridge`, `ViteHotSource`, `VitePluginUpdate`,
`VitePluginEvent`, `ViteBridge`, `ViteBridgeOptions`, and `ViteDiagnostic`.

## Status and documentation

Implemented and packaged at `0.1.1`; publication is pending. See the
[Moult repository](https://github.com/neryva-lab/moult), the
[adapter design](https://github.com/neryva-lab/moult/blob/main/docs/notes/05-adapters-and-host-integration.md),
and the [lifecycle guarantees](https://github.com/neryva-lab/moult/blob/main/docs/guarantees.md).
