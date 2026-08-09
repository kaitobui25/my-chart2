import { spawnSync } from 'node:child_process';

const testDirectory = process.argv[2];
const extraArgs = process.argv.slice(3);

if (!testDirectory) {
  console.error('Usage: node scripts/run-python-unittest.mjs <test-directory> [unittest args]');
  process.exit(2);
}

const candidates = process.platform === 'win32'
  ? [
      { command: 'py', prefixArgs: ['-3'] },
      { command: 'python', prefixArgs: [] },
    ]
  : [
      { command: 'python3.11', prefixArgs: [] },
      { command: 'python3', prefixArgs: [] },
      { command: 'python', prefixArgs: [] },
    ];

const python = candidates.find(({ command, prefixArgs }) => {
  const result = spawnSync(command, [
    ...prefixArgs,
    '-c',
    'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)',
  ], { stdio: 'ignore', windowsHide: true });
  return !result.error && result.status === 0;
});

if (!python) {
  console.error('Python 3.11 or newer is required to run the sidecar tests.');
  process.exit(1);
}

const result = spawnSync(python.command, [
  ...python.prefixArgs,
  '-m',
  'unittest',
  'discover',
  '-s',
  testDirectory,
  ...extraArgs,
], { stdio: 'inherit', windowsHide: false });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
