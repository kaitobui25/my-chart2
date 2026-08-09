import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DIR = path.join(ROOT, 'docs', 'current');
const META_PATH = path.join(CURRENT_DIR, '_meta.json');
const HUMAN_DOCS = [
  'README.md',
  'ARCHITECTURE.md',
  'FEATURES.md',
  'DATA_SOURCES.md',
  'SCANNER.md',
  'REPLAY.md',
  'OPERATIONS.md',
  'RECENT_CHANGES.md',
];
const VALID_MODES = new Set(['incremental', 'full-reconciliation']);

const [targetSha, mode] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(String(targetSha ?? ''))) {
  throw new Error('target SHA must be a 40-character lowercase Git SHA');
}
if (!VALID_MODES.has(mode)) {
  throw new Error(`mode must be one of: ${[...VALID_MODES].join(', ')}`);
}

const nowJapan = new Date(Date.now() + 9 * 60 * 60 * 1000);
const generatedAt = `${nowJapan.toISOString().slice(0, 19)}+09:00`;
const generatedDate = generatedAt.slice(0, 10);

const meta = JSON.parse(readFileSync(META_PATH, 'utf8'));
meta.schema_version = 1;
meta.source_branch = 'main';
meta.documented_sha = targetSha;
meta.generated_at = generatedAt;
meta.mode = mode;
writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);

for (const filename of HUMAN_DOCS) {
  const filePath = path.join(CURRENT_DIR, filename);
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const generatedIndexes = [];
  const shaIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^\*\*Generated:\*\*/.test(lines[index])) generatedIndexes.push(index);
    if (/^\*\*Documented main:\*\*/.test(lines[index])) shaIndexes.push(index);
  }

  if (generatedIndexes.length !== 1) {
    throw new Error(`${filename}: expected exactly one Generated header, found ${generatedIndexes.length}`);
  }
  if (shaIndexes.length !== 1) {
    throw new Error(`${filename}: expected exactly one Documented main header, found ${shaIndexes.length}`);
  }

  lines[generatedIndexes[0]] = `**Generated:** ${generatedDate}  `;
  lines[shaIndexes[0]] = `**Documented main:** \`${targetSha}\`  `;
  writeFileSync(filePath, lines.join('\n'));
}

console.log(`Synchronized current-doc snapshot metadata to ${targetSha} (${mode}) at ${generatedAt}.`);
