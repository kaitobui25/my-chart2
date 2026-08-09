import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'l2chart-package-'));
const npmCli = process.env.npm_execpath;

function runNpm(args, options) {
  if (npmCli) return execFileSync(process.execPath, [npmCli, ...args], options);
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(command, args, options);
}

try {
  runNpm(['run', 'build:lib'], { stdio: 'inherit' });
  const packed = JSON.parse(runNpm(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', directory],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ));
  const tarball = join(directory, packed[0].filename);

  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: directory, stdio: 'inherit' },
  );

  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { L2Chart, indicators } from 'lamlong-chart'; "
        + "console.log(JSON.stringify({ chart: typeof L2Chart, rsi: typeof indicators.rsi }));",
    ],
    { cwd: directory, encoding: 'utf8' },
  );
  const result = JSON.parse(output.trim());
  assert.equal(result.chart, 'function');
  assert.equal(result.rsi, 'function');
  console.log(`Verified ${packed[0].filename} (${packed[0].entryCount} files)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
