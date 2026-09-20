# @moult/devtools

Development-time diagnostics for [Moult](https://github.com/neryva-lab/moult): generation timelines and leak reports. Pure functions over the public `@moult/runtime` inspection surface — safe to bundle into dev builds and strip from production.

## Timeline

`timeline(runtime, pluginId?)` renders the runtime's transition audit log as a chronological list — installs, starts, replacements, pins, quarantines, stops — oldest first. Pass a plugin id for one plugin's generation history; omit it for the whole runtime.

```ts
import { createRuntime } from '@moult/runtime';
import { timeline } from '@moult/devtools';

const runtime = createRuntime();
// ... install, start, replace ...
for (const entry of timeline(runtime, 'my.plugin')) {
  console.log(entry.seq, new Date(entry.at).toISOString(), entry.type, entry.generation);
}
```

The log holds the most recent 128 transitions; older entries were evicted and are not shown.

## Leak report

`findLeaks(runtime)` surfaces everything the runtime is retaining that deserves a second look:

- **Pinned generations** — kept alive by `inFlight: 'pin'`, with retention age. Pins are manual; a pin older than the operation that created it is usually a forgotten handle.
- **Quarantined generations** — withdrawn from provider selection while their scope stays alive.
- **`validate()` issues** — stale bindings and orphaned generations are leaks in bookkeeping.
- **Plugin error trails** — failed starts, disposal failures, drain problems.
- **Observer errors** — throwing listeners never affect lifecycle outcomes, but a throwing listener is often a leaked subscription.

```ts
import { findLeaks } from '@moult/devtools';

const report = findLeaks(runtime);
if (!report.clean) {
  for (const r of report.retained) {
    console.log('retained', r.pluginId, r.reason, `${r.retainedForMs}ms`);
  }
}
```

Pins and quarantines are legitimate by design — the report surfaces them so a forgotten pin or a never-restored quarantine is visible, not so they can be auto-released.
