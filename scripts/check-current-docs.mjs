import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DIR = path.join(ROOT, 'docs', 'current');
const META_PATH = path.join(CURRENT_DIR, '_meta.json');

const REQUIRED_DOCS = [
  'README.md',
  'ARCHITECTURE.md',
  'FEATURES.md',
  'DATA_SOURCES.md',
  'SCANNER.md',
  'REPLAY.md',
  'OPERATIONS.md',
  'RECENT_CHANGES.md',
];

const VALID_MODES = new Set(['bootstrap', 'incremental', 'full-reconciliation']);
const EVIDENCE_PREFIXES = [
  'src/',
  'examples/',
  'scripts/',
  'tests/',
  'docs/',
  'agent/',
  '.github/',
];
const EVIDENCE_ROOT_FILES = new Set([
  'package.json',
  'README.md',
  'ASSISTANT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'RELEASING.md',
  'open-ai-chart.bat',
]);

const failures = [];

function fail(message) {
  failures.push(message);
}

function readRequired(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    fail(`Missing required file: ${relativePath}`);
    return '';
  }
  return readFileSync(fullPath, 'utf8');
}

for (const filename of REQUIRED_DOCS) {
  readRequired(path.join('docs', 'current', filename));
}

if (!existsSync(META_PATH)) {
  fail('Missing required file: docs/current/_meta.json');
}

let meta = null;
if (existsSync(META_PATH)) {
  try {
    meta = JSON.parse(readFileSync(META_PATH, 'utf8'));
  } catch (error) {
    fail(`docs/current/_meta.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (meta) {
  if (meta.schema_version !== 1) fail('docs/current/_meta.json schema_version must be 1');
  if (meta.source_branch !== 'main') fail('docs/current/_meta.json source_branch must be "main"');
  if (!/^[0-9a-f]{40}$/.test(String(meta.documented_sha ?? ''))) {
    fail('docs/current/_meta.json documented_sha must be a 40-character lowercase Git SHA');
  }
  if (!VALID_MODES.has(meta.mode)) {
    fail(`docs/current/_meta.json mode must be one of: ${[...VALID_MODES].join(', ')}`);
  }
  const generatedAt = Date.parse(String(meta.generated_at ?? ''));
  if (!Number.isFinite(generatedAt)) fail('docs/current/_meta.json generated_at must be an ISO date/time');
}

const documentedSha = meta && /^[0-9a-f]{40}$/.test(String(meta.documented_sha ?? ''))
  ? String(meta.documented_sha)
  : null;

function normalizeEvidenceToken(token) {
  return token
    .trim()
    .replace(/^\.\//, '')
    .replace(/[.,;:]+$/, '');
}

function isEvidencePath(token) {
  return EVIDENCE_ROOT_FILES.has(token)
    || EVIDENCE_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function validateEvidencePaths(filename, content) {
  const codeSpan = /`([^`\n]+)`/g;
  for (const match of content.matchAll(codeSpan)) {
    const token = normalizeEvidenceToken(match[1]);
    if (!isEvidencePath(token)) continue;
    if (/[*?{}\[\]]/.test(token)) continue;
    if (/\s/.test(token)) continue;
    const resolved = path.resolve(ROOT, token);
    if (!(resolved === ROOT || resolved.startsWith(`${ROOT}${path.sep}`))) {
      fail(`${filename}: evidence path escapes repository: ${token}`);
      continue;
    }
    if (!existsSync(resolved)) {
      fail(`${filename}: referenced repository path does not exist: ${token}`);
    }
  }
}

for (const filename of REQUIRED_DOCS) {
  const relative = path.join('docs', 'current', filename);
  const content = readRequired(relative);
  if (!content) continue;

  if (documentedSha && !content.includes(`**Documented main:** \`${documentedSha}\``)) {
    fail(`${relative}: documented main SHA does not match docs/current/_meta.json`);
  }

  validateEvidencePaths(relative, content);
}

const recentChangesPath = path.join(CURRENT_DIR, 'RECENT_CHANGES.md');
if (existsSync(recentChangesPath)) {
  const recent = readFileSync(recentChangesPath, 'utf8');
  const entries = recent.match(/^###\s+/gm)?.length ?? 0;
  if (entries > 50) fail(`docs/current/RECENT_CHANGES.md has ${entries} entries; maximum is 50`);
  const bytes = statSync(recentChangesPath).size;
  if (bytes > 64 * 1024) fail(`docs/current/RECENT_CHANGES.md is ${bytes} bytes; maximum is 65536`);
}

if (failures.length) {
  console.error('Current documentation validation failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`Current documentation validation passed for ${documentedSha ?? 'unknown SHA'}.`);
