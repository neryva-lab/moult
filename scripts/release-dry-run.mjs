// Non-publishing release rehearsal: reports the Changesets status, rebuilds
// and packaging-checks every workspace package, then runs `pnpm publish
// --dry-run` per package. Never requests credentials or creates dist-tags.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

function run(args) {
  const command = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : pnpm;
  const commandArgs = isWindows ? ['/d', '/s', '/c', pnpm, ...args] : args;
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(['changeset', 'status', '--verbose']);
run(['build']);
run(['check:pkg']);

const packageDirectories = readdirSync('packages')
  .map((entry) => join('packages', entry))
  .filter((directory) => statSync(directory).isDirectory());

for (const directory of packageDirectories) {
  run([
    '--dir',
    directory,
    'publish',
    '--dry-run',
    '--no-git-checks',
    '--tag',
    'dry-run',
    '--access',
    'public',
  ]);
}
