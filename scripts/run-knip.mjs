import { spawnSync } from 'node:child_process';

const environment = { ...process.env };

if (process.platform === 'win32') {
  environment.KNIP_DISABLE_RAW_TRANSFER = '1';
}

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const result = spawnSync(pnpmCommand, ['exec', 'knip'], {
  env: environment,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
