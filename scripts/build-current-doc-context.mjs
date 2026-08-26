import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [baselineSha, targetSha, mode, maxSourceFilesRaw = '25'] = process.argv.slice(2);
const SHA_RE = /^[0-9a-f]{40}$/;
const MODES = new Set(['incremental', 'full-reconciliation']);
const HUMAN_DOCS = [
  'docs/current/README.md',
  'docs/current/ARCHITECTURE.md',
  'docs/current/FEATURES.md',
  'docs/current/DATA_SOURCES.md',
  'docs/current/SCANNER.md',
  'docs/current/REPLAY.md',
  'docs/current/OPERATIONS.md',
  'docs/current/RECENT_CHANGES.md',
];

if (!SHA_RE.test(baselineSha ?? '') || !SHA_RE.test(targetSha ?? '')) {
  throw new Error('baseline_sha and target_sha must be 40-character lowercase git SHAs');
}
if (!MODES.has(mode)) {
  throw new Error(`Unsupported synchronization mode: ${mode}`);
}

const maxSourceFiles = Number.parseInt(maxSourceFilesRaw, 10);
if (!Number.isInteger(maxSourceFiles) || maxSourceFiles < 1 || maxSourceFiles > 100) {
  throw new Error('max source files must be an integer between 1 and 100');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function commitExists(sha) {
  return gitOrNull(['cat-file', '-e', `${sha}^{commit}`]) !== null;
}

function recoverBaseline(requestedBaseline, target) {
  if (commitExists(requestedBaseline)) return requestedBaseline;

  const originMain = gitOrNull(['rev-parse', '--verify', 'origin/main^{commit}']);
  if (originMain) {
    const mergeBase = gitOrNull(['merge-base', originMain, target]);
    if (mergeBase && mergeBase !== target) {
      console.error(`docs context: missing baseline ${requestedBaseline}; using merge-base ${mergeBase}`);
      return mergeBase;
    }
  }

  const roots = gitOrNull(['rev-list', '--max-parents=0', target]);
  const root = roots?.split('\n').map((value) => value.trim()).filter(Boolean)[0];
  if (!root) throw new Error(`unable to recover missing documentation baseline: ${requestedBaseline}`);
  console.error(`docs context: missing baseline ${requestedBaseline}; using repository root ${root}`);
  return root;
}

function routeChangedPath(file, routedDocs) {
  const add = (...docs) => docs.forEach((doc) => routedDocs.add(doc));

  if (file.startsWith('src/')) add('docs/current/FEATURES.md', 'docs/current/ARCHITECTURE.md');
  if (file.startsWith('examples/providers/')) add('docs/current/DATA_SOURCES.md');
  if (file.startsWith('examples/sidecars/fiinquant/')) add('docs/current/DATA_SOURCES.md', 'docs/current/OPERATIONS.md');
  if (file.startsWith('examples/sidecars/vnstock/')) add('docs/current/DATA_SOURCES.md', 'docs/current/OPERATIONS.md');
  if (file.startsWith('examples/sidecars/scanner/')) add('docs/current/SCANNER.md', 'docs/current/DATA_SOURCES.md');
  if (file.startsWith('examples/workstation/scanner/')) add('docs/current/SCANNER.md');
  if (file.startsWith('examples/workstation/replay/')) add('docs/current/REPLAY.md');
  if (file.startsWith('examples/workstation/trading/')) add('docs/current/FEATURES.md', 'docs/current/REPLAY.md');
  if (file.startsWith('migrations/')) add('docs/current/SCANNER.md', 'docs/current/DATA_SOURCES.md');

  if (
    file.startsWith('scripts/') ||
    file === 'package.json' ||
    file === 'package-lock.json' ||
    file.startsWith('.github/workflows/') ||
    file.startsWith('agent/opencode/') ||
    file.startsWith('agent/prompts/') ||
    /(^|\/)(\.env|env)(\.|$)/i.test(file)
  ) {
    add('docs/current/OPERATIONS.md');
  }

  if (file === 'README.md') add('docs/current/README.md');
}

const effectiveBaselineSha = recoverBaseline(baselineSha, targetSha);
const changedPaths = git(['diff', '--name-only', `${effectiveBaselineSha}..${targetSha}`])
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);

const meaningfulChangedPaths = changedPaths.filter(
  (file) => !file.startsWith('docs/current/') && !file.startsWith('agent/plan/'),
);

const routedDocs = new Set();
for (const file of meaningfulChangedPaths) routeChangedPath(file, routedDocs);
if (meaningfulChangedPaths.length > 0) {
  routedDocs.add('docs/current/RECENT_CHANGES.md');
}
if (
  meaningfulChangedPaths.some(
    (file) =>
      file.startsWith('.github/workflows/') ||
      file.startsWith('agent/opencode/') ||
      file.startsWith('agent/prompts/') ||
      file.startsWith('scripts/'),
  )
) {
  routedDocs.add('docs/current/README.md');
}

function collectEvidencePaths() {
  const perDoc = new Map();
  for (const doc of HUMAN_DOCS) {
    const text = fs.readFileSync(doc, 'utf8');
    const matches = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim());
    const candidates = [];
    for (const raw of matches) {
      const normalized = raw.replace(/^\.\//, '').replace(/[),.;:]+$/, '');
      if (!normalized.includes('/') || normalized.includes('*')) continue;
      if (normalized.startsWith('docs/current/') || normalized.startsWith('agent/plan/')) continue;
      const absolute = path.resolve(normalized);
      if (!absolute.startsWith(process.cwd() + path.sep)) continue;
      try {
        if (fs.statSync(absolute).isFile()) candidates.push(normalized);
      } catch {
        // Ignore stale/non-path inline code; the agent can correct it when routed evidence points there.
      }
    }
    perDoc.set(doc, [...new Set(candidates)]);
  }

  const result = [];
  const seen = new Set();
  let progressed = true;
  let round = 0;
  while (result.length < maxSourceFiles && progressed) {
    progressed = false;
    for (const doc of HUMAN_DOCS) {
      const candidate = perDoc.get(doc)?.[round];
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
      progressed = true;
      if (result.length >= maxSourceFiles) break;
    }
    round += 1;
  }
  return result;
}

const evidencePaths = mode === 'full-reconciliation' ? collectEvidencePaths() : [];
const sourceVerificationDocs =
  routedDocs.size > 0
    ? [...routedDocs]
    : mode === 'full-reconciliation'
      ? HUMAN_DOCS
      : [];

const output = {
  baseline_sha: effectiveBaselineSha,
  requested_baseline_sha: baselineSha,
  baseline_recovered: effectiveBaselineSha !== baselineSha,
  target_sha: targetSha,
  synchronization_mode: mode,
  max_implementation_source_files: maxSourceFiles,
  changed_path_count: meaningfulChangedPaths.length,
  changed_paths: meaningfulChangedPaths.slice(0, 120),
  changed_paths_truncated: meaningfulChangedPaths.length > 120,
  semantic_review_docs: mode === 'full-reconciliation' ? HUMAN_DOCS : sourceVerificationDocs,
  source_verification_docs: sourceVerificationDocs,
  evidence_paths: evidencePaths,
};

process.stdout.write(JSON.stringify(output));
