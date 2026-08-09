---
description: Keep docs/current synchronized with the implementation on main and maintain one docs-only draft PR when meaningful changes are found.
on:
  workflow_dispatch:
engine:
  id: copilot
  model: claude-sonnet-4.6
strict: true
permissions:
  contents: read
  pull-requests: read
  copilot-requests: write
checkout:
  ref: main
  fetch-depth: 0
  fetch:
    - "*"
network:
  allowed:
    - defaults
tools:
  edit:
  github:
    toolsets: [repos, pull_requests]
  bash:
    - "git:*"
    - "node scripts/check-current-docs.mjs"
    - "date:*"
safe-outputs:
  create-pull-request:
    title-prefix: "[docs-sync] "
    labels: [documentation]
    base-branch: main
    draft: true
    max: 1
    if-no-changes: ignore
    fallback-as-issue: false
    protected-files: blocked
    allowed-files:
      - "docs/current/**"
  push-to-pull-request-branch:
    target: "*"
    required-title-prefix: "[docs-sync] "
    required-labels: [documentation]
    max: 1
    if-no-changes: ignore
    fallback-as-pull-request: false
    protected-files: blocked
    allowed-files:
      - "docs/current/**"
  update-pull-request:
    target: "*"
    title: false
    body: true
    operation: replace
    required-title-prefix: "[docs-sync] "
    required-labels: [documentation]
    max: 1
---

# Canonical documentation synchronization

Keep `docs/current/` aligned with the implementation that exists on the repository's `main` branch.

This workflow is in **manual-first rollout mode**. It must be validated manually before the schedule is enabled in a follow-up change. The final daily behavior remains Monday-Saturday incremental synchronization plus Sunday full reconciliation.

This workflow maintains **current-state documentation**, not plans. Treat `agent/plan/**` as historical intent only.

## Hard rules

1. The truth hierarchy is:
   1. current source code on target `main`;
   2. tests;
   3. runtime configuration, package scripts, migrations and environment examples;
   4. merged commit history;
   5. existing `docs/current/**`;
   6. `agent/plan/**` only as historical context.
2. Never claim a feature is implemented because a plan says so.
3. Never edit anything outside `docs/current/**`. The safe-output allowlists enforce this too.
4. Never edit application code, tests, package manifests, workflow files, root documentation or `agent/plan/**`.
5. Do not use external web research to decide current repository behavior. Repository implementation is the authority.
6. Prefer explicit statuses such as `Verified`, `Implemented`, `Experimental`, `Partial`, `Deprecated` or `Unsupported` when certainty matters.
7. Never claim runtime verification unless source/tests/config provide evidence for that claim.
8. Preserve the distinction between raw market OHLC and derived Heikin Ashi display/scan data.
9. Preserve the distinction between chart-provider browser history cache and scanner SQLite storage.
10. Preserve the current `vn_eod` invariant: scanner execution is preloaded/local; CafeF ingestion is a separate import step.
11. `main` is the only documentation target. Never document the triggering branch or an arbitrary feature branch as current state.
12. Maintain at most one open `[docs-sync]` PR targeting `main`.

## Canonical files

Maintain exactly this current-state set:

- `docs/current/README.md`
- `docs/current/ARCHITECTURE.md`
- `docs/current/FEATURES.md`
- `docs/current/DATA_SOURCES.md`
- `docs/current/SCANNER.md`
- `docs/current/REPLAY.md`
- `docs/current/OPERATIONS.md`
- `docs/current/RECENT_CHANGES.md`
- `docs/current/_meta.json`

Do not add a new current-state page unless the existing structure genuinely cannot represent an important subsystem.

## Resolve target main and the rolling PR

The workflow checkout is pinned to `main` and fetches all branches. Resolve:

```bash
target_sha=$(git rev-parse origin/main)
```

Use the GitHub read tools to list open pull requests in the current repository and identify PRs that satisfy all of these conditions:

- base branch is `main`;
- title begins with `[docs-sync] `;
- label `documentation` is present;
- head repository is this same repository.

There must be zero or one matching rolling PR.

- If there are **two or more**, stop without editing or requesting any safe output. Ambiguous rolling state must be fixed by a human.
- If there is **exactly one**, record its PR number and exact head branch. This run must update that PR instead of creating another.
- If there are **none**, this run may create one new draft docs-sync PR if meaningful documentation changes are required.

Do not confuse the implementation PR that installed this automation with an actual `[docs-sync]` rolling PR.

## Resolve the documentation baseline

If there is no existing rolling PR, read `docs/current/_meta.json` from the checked-out `main` tree and use its `documented_sha` as `baseline_sha`.

If a rolling PR exists, its branch contains the newest unmerged docs snapshot. Read that branch's metadata without switching away from `main`, for example:

```bash
git show "origin/<docs-sync-head>:docs/current/_meta.json"
```

Use that PR metadata's `documented_sha` as `baseline_sha`.

At this stage remain on the `main` checkout so all implementation inspection is performed against target main, not against an older rolling-PR branch.

## Resolve the synchronization mode

Use Japan time to decide the weekly reconciliation day. Sunday is a full reconciliation day.

```bash
TZ=Asia/Tokyo date +%u
```

where `7` means Sunday.

### Sunday

Perform **full reconciliation**, even when `baseline_sha == target_sha`.

Re-read the current repository implementation needed to validate every canonical page. Existing docs are comparison targets, not authority. If the docs are already correct, make no changes and do not request a PR or push.

### Monday-Saturday

If `baseline_sha == target_sha`, stop with no changes and do not request a PR or push.

Otherwise verify the baseline before using incremental mode:

```bash
git cat-file -e "${baseline_sha}^{commit}"
git merge-base --is-ancestor "$baseline_sha" origin/main
```

If either check fails, use full reconciliation instead of guessing from an invalid baseline.

## Incremental inspection

For a valid baseline, inspect at minimum:

```bash
git diff --name-status "$baseline_sha..$target_sha"
git log --oneline --decorate "$baseline_sha..$target_sha"
```

Changes only under `docs/current/**` or `agent/plan/**` do not by themselves prove that implementation documentation needs a body update.

For every meaningful changed subsystem, read the full relevant implementation plus nearby tests/config/migrations from target `main`. Do not document behavior from a diff snippet or commit title alone.

Use this routing only as guidance:

- `src/**` → `FEATURES.md`; `ARCHITECTURE.md` when boundaries/ownership change.
- `examples/providers/**` → `DATA_SOURCES.md`; operations when startup/cache behavior changes.
- `examples/sidecars/fiinquant/**` → `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/vnstock/**` → `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/scanner/**` → `SCANNER.md`; `DATA_SOURCES.md` for source/storage capability changes.
- `examples/workstation/scanner/**` → `SCANNER.md`; also operations/architecture when runtime integration changes.
- `examples/workstation/replay/**` → `REPLAY.md`.
- `examples/workstation/trading/**` → `FEATURES.md`; `REPLAY.md` when quote/source ownership changes.
- `scripts/**`, `package.json`, environment examples → `OPERATIONS.md`.
- scanner migrations → `SCANNER.md` and, when storage/source meaning changes, `DATA_SOURCES.md`.

Always decide whether `README.md`, `FEATURES.md` and `RECENT_CHANGES.md` need a body update for the meaningful change.

Complete implementation inspection while still on target `main`. If you later need another source file after switching to a rolling PR branch, read the exact target version with `git show "$target_sha:<path>"` or the GitHub read tools at `main`; do not accidentally use stale implementation from the PR branch.

## Choose the editing branch

Only after implementation inspection has determined that documentation must change:

### No existing rolling PR

Stay on the checked-out `main` commit. Edit only `docs/current/**` and request `create-pull-request` after validation.

### Existing rolling PR

Switch the workspace to the exact same-repository PR head branch that was discovered earlier, using the already-fetched remote branch as the source:

```bash
git switch -C "<docs-sync-head>" "origin/<docs-sync-head>"
```

Do not merge or rebase `main` into that branch. The rolling PR should accumulate docs-only commits; application changes remain on `main` and are inspected by SHA.

Edit only `docs/current/**`. Commit the validated docs-only change on that PR head branch before requesting `push-to-pull-request-branch` for the recorded PR number.

## Updating the documented SHA

When implementation changes require a current-doc update:

1. set `docs/current/_meta.json.documented_sha` to `target_sha`;
2. set `_meta.json.generated_at` to the current Japan-time ISO timestamp with `+09:00` offset;
3. set `_meta.json.mode` to `incremental` or `full-reconciliation`;
4. update the `Generated` and `Documented main` header lines in **all eight human-facing canonical pages** so they match `_meta.json`, even when a page body did not otherwise change.

This mechanical header synchronization is intentional. It lets the deterministic checker prove that the canonical set represents one repository snapshot.

## Documentation quality rules

- Describe current behavior, not intended future behavior.
- Keep source-path evidence concrete and current.
- If code exists but runtime availability depends on credentials/upstream access, say so.
- If implementation exists without enough evidence to call it verified, use `Implemented`, not `Verified`.
- Keep architectural maintenance hotspots visible when they materially affect future work.
- Do not erase useful known limitations simply because the latest change did not touch them.
- Do not turn `RECENT_CHANGES.md` into a raw commit dump. Add only meaningful behavioral, data-flow, architectural or operational changes.
- Keep `RECENT_CHANGES.md` to at most 50 `###` change entries.

## Validation

After editing, run:

```bash
node scripts/check-current-docs.mjs
```

If validation fails, fix only `docs/current/**` and rerun it. If the failure cannot be fixed without touching another path, stop and do not request a safe output.

Review the final diff against the branch state before this run. Every changed path attributable to this workflow must be under `docs/current/**`.

## Safe-output behavior

Only when validated current-doc changes exist:

### New rolling PR

Request `create-pull-request` once. The configured policy enforces:

- base branch `main`;
- title prefix `[docs-sync] `;
- label `documentation`;
- draft state;
- `docs/current/**` as the exclusive file allowlist.

Use a concise title such as `sync main through abc1234` after the enforced prefix.

### Existing rolling PR

Request `push-to-pull-request-branch` for the recorded PR number, then request `update-pull-request` for that same PR number so the body describes the latest sync. The configured policy requires the `[docs-sync] ` title prefix and `documentation` label before either update is accepted.

Never create a second PR while a matching rolling PR is open.

The PR body must state:

- baseline SHA;
- target SHA;
- synchronization mode;
- meaningful subsystems inspected;
- pages whose bodies changed;
- pages changed only for snapshot header synchronization;
- implementation/test/config evidence used;
- any uncertainty or runtime behavior deliberately not claimed.

If there is no meaningful current-state change, or a full reconciliation finds no correction needed, do not request a PR, push, or body update.

## Rollout gate

This checked-in version is **manual only**. Do not infer that daily scheduling is already enabled merely from the filename.

After merge to default branch:

1. run the workflow manually against real repository state;
2. inspect any resulting docs-only draft PR or verify a correct no-op;
3. verify rolling behavior on the first real follow-up update;
4. configure `GH_AW_CI_TRIGGER_TOKEN` before unattended operation so PRs/pushes produced by Agentic Workflows can trigger normal repository CI;
5. only then change the workflow trigger from manual-only to daily + manual in a small follow-up PR.

Auto-merge remains disabled until 7-14 reviewed docs-sync updates have demonstrated stable behavior.
