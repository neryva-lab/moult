import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

interface BrowserResult {
  readonly initial: string;
  readonly afterFailedReplacement: string;
  readonly afterSuccessfulReplacement: string;
}

test.describe('browser smoke (INV-06/07)', () => {
  test('INV-06/07: happy activation and failed replacement preserve committed UI state', async ({
    page,
  }) => {
    const runtimeSource = await readFile(
      join(root, 'packages', 'runtime-core', 'dist', 'index.js'),
      'utf8',
    );
    const browserRuntimeSource = runtimeSource.replace('from "semver"', 'from "/semver.js"');
    if (browserRuntimeSource === runtimeSource) {
      throw new Error('browser smoke could not locate the runtime semver import');
    }
    const semverSource = `export const valid = (value) => /^\\d+\\.\\d+\\.\\d+$/.test(value) ? value : null;
      export const validRange = (value) => typeof value === 'string' && value.length > 0 ? value : null;
      export const satisfies = () => true;`;
    const html = `<!doctype html><html><body><output id="result"></output><script type="module">
      import { capability, contributionKey, createRuntime } from '/runtime.js';
      const token = capability('browser.smoke.value', '1.0.0');
      const ui = contributionKey('browser.smoke.ui');
      const definition = (version, fail = false) => ({
        id: 'browser.smoke.plugin', version, provides: [{ capability: token }],
        setup: (ctx) => { ctx.provide(token, { version }); ctx.contribute(ui, { version }); if (fail) throw new Error('candidate failed'); }
      });
      const runtime = createRuntime();
      runtime.install(definition('1.0.0'));
      await runtime.start('browser.smoke.plugin');
      const value = () => runtime.contributions().entries.get(ui.id)[0].value.version;
      const initial = value();
      try { await runtime.replace(definition('2.0.0', true)); } catch (_) {}
      const afterFailedReplacement = value();
      await runtime.replace(definition('2.0.0'));
      const afterSuccessfulReplacement = value();
      globalThis.__moltResult = { initial, afterFailedReplacement, afterSuccessfulReplacement };
      document.querySelector('#result').textContent = JSON.stringify(globalThis.__moltResult);
      await runtime.dispose();
    </script></body></html>`;
    const server = createServer((request, response) => {
      if (request.url === '/runtime.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(browserRuntimeSource);
        return;
      }
      if (request.url === '/semver.js') {
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(semverSource);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('browser smoke server did not expose a TCP address');
    }
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.waitForFunction(() => {
        const result = (globalThis as typeof globalThis & { __moltResult?: BrowserResult })
          .__moltResult;
        return result !== undefined;
      });
      const result = await page.evaluate(() => {
        const value = (globalThis as typeof globalThis & { __moltResult?: BrowserResult })
          .__moltResult;
        if (value === undefined) throw new Error('browser result missing');
        return value;
      });
      expect(result).toEqual({
        initial: '1.0.0',
        afterFailedReplacement: '1.0.0',
        afterSuccessfulReplacement: '2.0.0',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
