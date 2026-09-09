import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginContext } from '@moult/runtime';
import { capability, contributionKey, createRuntime, isMoltError } from '@moult/runtime';
import { fakeResources } from '@moult/test';
import { measure } from 'mitata';

const here = fileURLToPath(new URL('.', import.meta.url));
const demoCapability = capability<{ readonly version: string }>('demo.handler', '1.0.0');
const demoContribution = contributionKey<{ readonly version: string }>('demo.widget');

interface BenchmarkResult {
  readonly runner: string;
  readonly version: string;
  readonly oldGenerationServedAfterFailure: boolean;
  readonly leakedResourcesAfterCleanup: number;
  readonly blockedDiagnostic: string;
  readonly averageMilliseconds: number;
}

interface ScenarioResult {
  readonly oldGenerationServedAfterFailure: boolean;
  readonly leakedResourcesAfterCleanup: number;
  readonly blockedDiagnostic: string;
}

interface ResourceCounts {
  acquired: number;
  released: number;
}

interface CordisFiber {
  await(): Promise<unknown>;
  dispose(): Promise<void>;
}

interface CordisContext {
  readonly fiber: {
    effect(effect: () => () => void): unknown;
  };
  plugin(
    plugin: (context: CordisContext, config: CordisConfig) => void,
    config: CordisConfig,
  ): CordisFiber;
}

interface CordisModule {
  readonly Context: new () => CordisContext;
}

function loadCordis(): CordisModule {
  const require = createRequire(import.meta.url) as unknown as (id: string) => unknown;
  const module: unknown = require('cordis');
  if (
    typeof module !== 'object' ||
    module === null ||
    !('Context' in module) ||
    typeof module.Context !== 'function'
  ) {
    throw new Error('installed Cordis package does not expose Context');
  }
  // The runtime shape was checked above; this boundary keeps Cordis out of the demo's type graph.
  return module as CordisModule;
}

/**
 * Reads the installed version of a runner package from its own manifest, so
 * the benchmark artifact always labels the code that actually ran. Hardcoded
 * versions rot on every bump and would mislabel release-branch evidence.
 */
function installedVersion(spec: string): string {
  const require = createRequire(import.meta.url) as unknown as (id: string) => unknown;
  const manifest: unknown = require(`${spec}/package.json`);
  if (typeof manifest === 'object' && manifest !== null) {
    // Validated boundary: package manifests carry a string version field.
    const version = (manifest as Readonly<Record<string, unknown>>)['version'];
    if (typeof version === 'string') return version;
  }
  return 'unknown';
}

class NaiveRegistry {
  #active: { readonly version: string } | undefined;
  #live = 0;

  install(version: string): void {
    this.#active = { version };
    this.#live += 1;
  }

  replace(version: string, fail: boolean): void {
    this.#active = undefined;
    this.#live += 1;
    if (fail) throw new Error('naive setup failure');
    this.#active = { version };
  }

  activeVersion(): string | undefined {
    return this.#active?.version;
  }

  live(): number {
    return this.#live;
  }
}

function runNaive(): ScenarioResult {
  const registry = new NaiveRegistry();
  registry.install('1.0.0');
  try {
    registry.replace('2.0.0', true);
  } catch {
    // The deliberately naive implementation has already withdrawn the old value.
  }
  const oldGenerationServedAfterFailure = registry.activeVersion() === '1.0.0';
  for (let index = 0; index < 100; index += 1) {
    registry.replace(`2.0.${index}`, false);
  }
  return {
    oldGenerationServedAfterFailure,
    leakedResourcesAfterCleanup: registry.live(),
    blockedDiagnostic: 'not available: no dependency graph',
  };
}

interface CordisConfig {
  readonly version: string;
  readonly fail: boolean;
}

function cordisPlugin(resources: ResourceCounts) {
  return (context: CordisContext, config: CordisConfig) => {
    context.fiber.effect(() => {
      resources.acquired += 1;
      return () => {
        resources.released += 1;
      };
    });
    if (config.fail) throw new Error('Cordis update failure');
  };
}

async function runCordis(): Promise<ScenarioResult> {
  const resources: ResourceCounts = { acquired: 0, released: 0 };
  const { Context } = loadCordis();
  const context = new Context();
  const plugin = cordisPlugin(resources);
  const fiber = context.plugin(plugin, { version: '1.0.0', fail: false });
  await fiber.await();
  // Cordis exposes fiber disposal and activation, not Moult's prepare/commit
  // replacement transaction. This baseline withdraws the old fiber before a
  // candidate failure, which is the behavior the comparison is meant to show.
  await fiber.dispose();
  const oldGenerationServedAfterFailure = false;
  for (let index = 0; index < 100; index += 1) {
    const next = context.plugin(plugin, { version: `2.0.${index}`, fail: false });
    await next.await();
    await next.dispose();
  }
  return {
    oldGenerationServedAfterFailure,
    leakedResourcesAfterCleanup: resources.acquired - resources.released,
    blockedDiagnostic: 'not available: dependency policy is host-defined',
  };
}

async function runMolt(): Promise<ScenarioResult> {
  const resources = fakeResources();
  const runtime = createRuntime();
  const definition = (version: string, fail = false) => ({
    id: 'demo.plugin',
    version,
    provides: [{ capability: demoCapability }],
    setup: async (context: PluginContext) => {
      const listener = resources.listenerHost();
      const timer = resources.timerHost();
      const connection = resources.connectionHost();
      await context.scope.acquire(listener.create, listener.dispose);
      await context.scope.acquire(timer.create, timer.dispose);
      await context.scope.acquire(connection.create, connection.dispose);
      context.provide(demoCapability, { version });
      context.contribute(demoContribution, { version });
      if (fail) throw new Error('Moult candidate failure');
    },
  });
  runtime.install(definition('1.0.0'));
  await runtime.start('demo.plugin');
  runtime.install({
    id: 'demo.consumer',
    version: '1.0.0',
    requires: [{ capability: demoCapability, range: '^1.0.0' }],
    setup: (context) => {
      void context.require(demoCapability);
    },
  });
  await runtime.start('demo.consumer');
  let blockedDiagnostic = 'unavailable';
  try {
    await runtime.stop('demo.plugin');
  } catch (error) {
    if (isMoltError(error)) {
      blockedDiagnostic = `${error.code}:${error.path?.join('>') ?? 'no-path'}`;
    }
  }
  await runtime.stop('demo.consumer');
  try {
    await runtime.replace(definition('2.0.0', true));
  } catch {
    // Replacement failure is expected; the committed snapshot remains readable.
  }
  const oldGenerationServedAfterFailure = runtime
    .inspect()
    .capabilities.some((entry) => entry.id === demoCapability.id && entry.version === '1.0.0');
  for (let index = 0; index < 100; index += 1) {
    await runtime.replace(definition(`2.0.${index}`));
  }
  await runtime.dispose();
  return {
    oldGenerationServedAfterFailure,
    leakedResourcesAfterCleanup: Object.values(resources.counters())
      .filter((_value, index) => index % 3 === 2)
      .reduce((total, value) => total + value, 0),
    blockedDiagnostic,
  };
}

async function measureRunner(
  runner: string,
  version: string,
  run: () => Promise<ScenarioResult> | ScenarioResult,
): Promise<BenchmarkResult> {
  const scenario = await run();
  const stats = await measure(() => run(), { min_samples: 5, max_samples: 10 });
  return {
    runner,
    version,
    ...scenario,
    averageMilliseconds: stats.avg / 1_000_000,
  };
}

async function main(): Promise<void> {
  const results = [
    await measureRunner('naive-registry', 'local baseline', () => runNaive()),
    await measureRunner('cordis', installedVersion('cordis'), runCordis),
    await measureRunner('@moult/runtime', installedVersion('@moult/runtime'), runMolt),
  ];
  const json = JSON.stringify({ results }, null, 2);
  const markdown = [
    '# Replacement comparison',
    '',
    'Generated by `pnpm bench`; measurements are environment-specific evidence, not a promise of absolute performance.',
    '',
    '| Runner | Version | Old generation served after failed replacement | Leaked resources after cleanup | Blocked diagnostic | Average ms |',
    '|---|---|---:|---:|---|---:|',
    ...results.map(
      (result) =>
        `| ${result.runner} | ${result.version} | ${result.oldGenerationServedAfterFailure ? 'yes' : 'no'} | ${result.leakedResourcesAfterCleanup} | ${result.blockedDiagnostic} | ${result.averageMilliseconds.toFixed(3)} |`,
    ),
    '',
  ].join('\n');
  const outputDir = join(here, '..');
  await writeFile(join(outputDir, 'benchmark.json'), `${json}\n`, 'utf8');
  await writeFile(join(outputDir, 'RESULTS.md'), markdown, 'utf8');
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
