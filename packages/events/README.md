# @moult/events

Generation-scoped, typed events for Moult plugins and hosts.

## Installation

```bash
npm install @moult/events @moult/runtime
```

Requires Node.js 22 or newer.

## Example

Subscriptions belong to a plugin scope. Disposing that generation removes its
listeners automatically.

```ts
import { createEventBus } from '@moult/events';
import { createRuntime } from '@moult/runtime';

type AppEvents = {
  message: string;
  count: number;
};

const runtime = createRuntime();
const bus = createEventBus<AppEvents>('sync');

runtime.install({
  id: 'logger',
  version: '1.0.0',
  setup: (context) => {
    bus.on(context.scope, 'message', (message) => {
      console.log(message);
    });
  },
});

await runtime.start('logger');
bus.emit('message', 'hello');
await runtime.dispose(); // removes the logger subscription
```

## Features

- Event names and payloads are checked by TypeScript.
- Synchronous and asynchronous delivery modes are supported.
- Subscriber failures are isolated and reported through an optional diagnostic
  callback.
- Asynchronous delivery preserves order per event key.
- Subscriptions are owned by the supplied Moult scope.
- `eventBusFactory` and `eventBusCapability` support host-provided buses.

This package is an event capability, not a second lifecycle system or a global
application registry. Plugin replacement and disposal remain owned by
`@moult/runtime`.

## Public API

The package exports `createEventBus`, `eventBusFactory`, `eventBusCapability`,
`TypedEventCapability`, `EventBusFactory`, `EventMap`, `EventListener`,
`EventDiagnostic`, and `DeliveryMode`.

## Status and documentation

Implemented and packaged at `0.1.1`; publication is pending. See the
[Moult repository](https://github.com/neryva-lab/moult), the
[adapter design](https://github.com/neryva-lab/moult/blob/main/docs/notes/05-adapters-and-host-integration.md),
and the [lifecycle guarantees](https://github.com/neryva-lab/moult/blob/main/docs/guarantees.md).
