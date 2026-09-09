import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  minify: false,
  outDir: 'dist',
  platform: 'node',
  deps: { neverBundle: ['@moult/runtime'] },
  outExtensions: (context) =>
    context.format === 'cjs' ? { js: '.cjs', dts: '.d.cts' } : { js: '.js', dts: '.d.ts' },
});
