# @moult/react

React bindings for committed, generation-scoped Moult contributions.

## Installation

```bash
npm install @moult/react @moult/runtime react react-dom
```

Requires Node.js 22 or newer and React 18 or newer.

## Example

`RuntimeProvider` exposes only committed contribution snapshots. A failed
replacement cannot render staged values.

```tsx
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRuntime } from '@moult/runtime';
import { RuntimeProvider, reactWidget, useContributions } from '@moult/react';

const runtime = createRuntime();
runtime.install({
  id: 'welcome',
  version: '1.0.0',
  setup: (context) => {
    context.contribute(reactWidget, {
      component: () => createElement('strong', null, 'Hello from Moult'),
    });
  },
});
await runtime.start('welcome');

function Widgets() {
  const widgets = useContributions(reactWidget);
  return createElement(
    'div',
    null,
    widgets.map((widget, index) => createElement(widget.component, { key: index })),
  );
}

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('missing #root element');
createRoot(rootElement).render(createElement(RuntimeProvider, { runtime }, createElement(Widgets)));
```

## Features

- `RuntimeProvider` publishes committed runtime snapshots to React.
- `useContributions` reads values for a typed contribution key.
- `useContributionEntries` also exposes generation ownership metadata.
- `reactRoute` and `reactWidget` provide standard contribution keys.
- `ContributionErrorBoundary` isolates a contribution's render failure.
- `guardGenerationCallback` prevents callbacks from acting after disposal or
  replacement.

React component state is not promised to survive generation replacement.
Durable application state belongs in a host-provided capability.

## Public API

The package exports `RuntimeProvider`, `useContributions`,
`useContributionEntries`, `ContributionErrorBoundary`,
`guardGenerationCallback`, `reactRoute`, `reactWidget`, and their public prop
and contribution types.

## Status and documentation

Implemented and packaged at `0.1.1`; publication is pending. See the
[Moult repository](https://github.com/neryva-lab/moult), the
[adapter design](https://github.com/neryva-lab/moult/blob/main/docs/notes/05-adapters-and-host-integration.md),
and the [lifecycle guarantees](https://github.com/neryva-lab/moult/blob/main/docs/guarantees.md).
