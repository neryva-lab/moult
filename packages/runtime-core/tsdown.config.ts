// Build: dual ESM/CJS, unminified — consumers run their own bundlers.
// tsdown 0.22 defaults to .mjs names; the exports map in package.json pins
// dist/index.js (ESM), dist/index.cjs (CJS), and dist/index.d.ts (types),
// so the extensions are set explicitly. api-extractor rolls its reviewed
// report from the built dist/index.d.ts.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  minify: false,
  outDir: 'dist',
  platform: 'node',
  outExtensions: (context) =>
    context.format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.js', dts: '.d.ts' },
});
