import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const hasPendingChangesets = readdirSync('.changeset', { withFileTypes: true }).some(
  (entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md',
);

if (!hasPendingChangesets) {
  console.log('No unreleased changesets found; skipping versioning.');
  process.exit(0);
}

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpmCommand, ['changeset', 'version'], { stdio: 'inherit' });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
