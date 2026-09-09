import { defineConfig } from 'vitest/config';

// Package-local entry point (used when running inside packages/runtime-core).
// The root vitest.config.ts defines the unit/property/stress projects for
// workspace-wide runs; the coverage thresholds below are mirrored there.
// Keep the two blocks identical.
export default defineConfig({
  test: {
    name: 'unit',
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['test/property/**', 'test/stress/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/index.ts'], // re-export barrel: no runtime logic
      thresholds: {
        // Coverage gates: 90 lines / 80 branches globally, with a per-file
        // exception for the runtime.ts defense-in-depth guards — they cover
        // states the invariants make unreachable.
        lines: 90,
        branches: 80,
        'src/runtime.ts': { lines: 87, branches: 69 },
      },
    },
  },
});
