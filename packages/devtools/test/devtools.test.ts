import { createRuntime } from '@moult/runtime';

import { findLeaks, timeline } from '../src/index.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('timeline', () => {
  it('returns one plugin generations in chronological order', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.tlplugin', version: '1.0.0', setup: () => {} });
    await runtime.start('test.tlplugin');
    await runtime.replace({ id: 'test.tlplugin', version: '2.0.0', setup: () => {} });
    await runtime.stop('test.tlplugin');

    const entries = timeline(runtime, 'test.tlplugin');
    expect(entries.map((entry) => entry.type)).toEqual([
      'installed',
      'started',
      'replaced',
      'stopped',
    ]);
    // Chronological with monotonic sequence numbers.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.seq).toBeGreaterThan(entries[i - 1]?.seq ?? -1);
      expect(entries[i]?.at).toBeGreaterThanOrEqual(entries[i - 1]?.at ?? -1);
    }
    for (const entry of entries) {
      expect(entry.pluginId).toBe('test.tlplugin');
    }
    await runtime.dispose();
  });

  it('without a plugin id returns the whole runtime', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.tl1', version: '1.0.0', setup: () => {} });
    runtime.install({ id: 'test.tl2', version: '1.0.0', setup: () => {} });
    const entries = timeline(runtime);
    expect(entries.map((entry) => entry.pluginId)).toEqual(['test.tl1', 'test.tl2']);
    await runtime.dispose();
  });
});

describe('findLeaks', () => {
  it('reports a clean runtime as clean', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.lkplugin', version: '1.0.0', setup: () => {} });
    await runtime.start('test.lkplugin');
    const report = findLeaks(runtime);
    expect(report.clean).toBe(true);
    expect(report.retained).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.pluginErrors).toEqual([]);
    expect(report.observerErrors).toEqual([]);
    await runtime.dispose();
  });

  it('surfaces pinned and quarantined generations with retention age', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    let healthy = true;
    runtime.install({
      id: 'test.lkq',
      version: '1.0.0',
      setup: () => {},
      healthCheck: () => (healthy ? { ok: true } : { ok: false, message: 'sick' }),
    });
    runtime.install({ id: 'test.lkp', version: '1.0.0', setup: () => {} });
    await runtime.start('test.lkq');
    await runtime.start('test.lkp');
    await runtime.replace(
      { id: 'test.lkp', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    healthy = false;
    await runtime.checkHealth('test.lkq');

    const report = findLeaks(runtime);
    expect(report.clean).toBe(false);
    const reasons = new Map(report.retained.map((r) => [r.pluginId, r.reason]));
    expect(reasons.get('test.lkp')).toBe('pinned');
    expect(reasons.get('test.lkq')).toBe('quarantined');
    for (const retained of report.retained) {
      expect(retained.retainedForMs).toBeDefined();
      expect(retained.retainedForMs ?? -1).toBeGreaterThanOrEqual(0);
    }
    await runtime.dispose();
  });

  it('surfaces plugin error trails', async () => {
    const runtime = createRuntime();
    runtime.install({
      id: 'test.lkerr',
      version: '1.0.0',
      setup: () => {
        throw new Error('boom');
      },
    });
    await expect(runtime.start('test.lkerr')).rejects.toThrow();
    const report = findLeaks(runtime);
    expect(report.clean).toBe(false);
    expect(report.pluginErrors.map((entry) => entry.pluginId)).toEqual(['test.lkerr']);
    await runtime.dispose();
  });

  it('a released pin disappears from the report', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.lkr', version: '1.0.0', setup: () => {} });
    await runtime.start('test.lkr');
    await runtime.replace(
      { id: 'test.lkr', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    expect(findLeaks(runtime).retained.length).toBe(1);
    await runtime.stop('test.lkr');
    const report = findLeaks(runtime);
    expect(report.retained).toEqual([]);
    await runtime.dispose();
  });

  it('retention age is undefined when the transition was evicted', async () => {
    const runtime = createRuntime();
    runtime.install({ id: 'test.lkold', version: '1.0.0', setup: () => {} });
    await runtime.start('test.lkold');
    await runtime.replace(
      { id: 'test.lkold', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    // Push the pin transition out of the 128-entry buffer.
    for (let n = 0; n < 50; n += 1) {
      const id = `test.lkfiller${String(n)}`;
      runtime.install({ id, version: '1.0.0', setup: () => {} });
      await runtime.start(id);
      await runtime.stop(id);
    }
    const report = findLeaks(runtime);
    const pinned = report.retained.find((r) => r.pluginId === 'test.lkold');
    expect(pinned?.reason).toBe('pinned');
    expect(pinned?.retainedForMs).toBeUndefined();
    await runtime.dispose();
  });

  it('does not conflate a released pin with a later quarantine', async () => {
    const runtime = createRuntime({ onUnhealthy: 'quarantine' });
    let healthy = true;
    // Quarantine first so the quarantine transition is older.
    runtime.install({
      id: 'test.lkmix',
      version: '1.0.0',
      setup: () => {},
      healthCheck: () => (healthy ? { ok: true } : { ok: false }),
    });
    await runtime.start('test.lkmix');
    healthy = false;
    await runtime.checkHealth('test.lkmix');
    await delay(5);
    // Restore, then pin: the pin transition is newer.
    healthy = true;
    await runtime.checkHealth('test.lkmix');
    await runtime.replace(
      { id: 'test.lkmix', version: '2.0.0', setup: () => {} },
      { inFlight: 'pin' },
    );
    const report = findLeaks(runtime);
    expect(report.retained.map((r) => r.reason)).toEqual(['pinned']);
    await runtime.dispose();
  });
});
