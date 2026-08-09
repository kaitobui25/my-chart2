---
description: Keep docs/current synchronized with the implementation on main and open a docs-only draft PR when meaningful changes are found.
on: daily
engine: copilot
strict: true
permissions:
  contents: read
  copilot-requests: write
checkout:
  fetch-depth: 0
network:
  allowed:
    - defaults
tools:
  edit:
  bash:
    - "git:*"
    - "node scripts/check-current-docs.mjs"
    - "date:*"
safe-outputs:
  create-pull-request:
    title-prefix: "[docs-sync] "
    draft: true
    max: 1
    if-no-changes: ignore
    fallback-as-issue: false
    protected-files: blocked
    allowed-files:
      - "docs/current/**"
---

# Daily canonical documentation synchronization

Keep `docs/current/` aligned with the implementation that exists on the checked-out `main` commit.

This workflow maintains **current-state documentation**, not plans. Treat `agent/plan/**` as historical intent only.

## Hard rules

1. The truth hierarchy is:
   1. current source code;
   2. tests;
   3. runtime configuration, package scripts, migrations and environment examples;
   4. merged commit history;
   5. existing `docs/current/**`;
   6. `agent/plan/**` only as historical context.
2. Never claim a feature is implemented because a plan says so.
3. Never edit anything outside `docs/current/**`. The safe-output allowlist enforces this too.
4. Never edit application code, tests, package manifests, workflow files, root documentation or `agent/plan/**`.
5. Do not use external web research to decide current repository behavior. Repository implementation is the authority.
6. Prefer explicit statuses such as `Verified`, `Implemented`, `Experimental`, `Partial`, `Deprecated` or `Unsupported` when certainty matters.
7. Never claim runtime verification unless source/tests/config provide evidence for that claim.
8. Preserve the distinction between raw market OHLC and derived Heikin Ashi display/scan data.
9. Preserve the distinction between chart-provider browser history cache and scanner SQLite storage.
10. Preserve the current `vn_eod` invariant: scanner execution is preloaded/local; CafeF ingestion is a separate import step.

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

## Resolve the synchronization mode

Read `docs/current/_meta.json` and resolve:

- `baseline_sha = documented_sha`
- `target_sha = git rev-parse HEAD`

Use Japan time to decide the weekly reconciliation day. Sunday is a full reconciliation day.

A safe way to inspect the weekday is:

```bash
TZ=Asia/Tokyo date +%u
```

where `7` means Sunday.

### Sunday

Perform **full reconciliation**, even when `baseline_sha == target_sha`.

Re-read the current repository implementation needed to validate every canonical page. Existing docs are comparison targets, not authority. If the docs are already correct, make no changes and do not request a PR.

### Monday-Saturday

If `baseline_sha == target_sha`, stop with no changes and do not request a PR.

Otherwise verify the baseline before using incremental mode:

```bash
git cat-file -e "${baseline_sha}^{commit}"
git merge-base --is-ancestor "$baseline_sha" HEAD
```

If either check fails, use full reconciliation instead of guessing from an invalid baseline.

## Incremental inspection

For a valid baseline, inspect at minimum:

```bash
git diff --name-status "$baseline_sha..$target_sha"
git log --oneline --decorate "$baseline_sha..$target_sha"
```

Changes only under `docs/current/**` or `agent/plan/**` do not by themselves prove that implementation documentation needs a body update.

For every meaningful changed subsystem, read the full relevant implementation plus nearby tests/config/migrations. Do not document behavior from a diff snippet or commit title alone.

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

## Updating the documented SHA

When implementation changes require a current-doc update:

1. set `docs/current/_meta.json.documented_sha` to `target_sha`;
2. set `_meta.json.generated_at` to the current Japan-time ISO timestamp;
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

If validation fails, fix only `docs/current/**` and rerun it. If the failure cannot be fixed without touching another path, stop and do not request a pull request.

Review the final diff. It must contain only `docs/current/**`.

## Pull request

Only when validated current-doc changes exist, request one draft pull request through the configured safe output.

Use a concise title after the enforced `[docs-sync] ` prefix, for example `sync main through abc1234`.

The PR body must state:

- baseline SHA;
- target SHA;
- synchronization mode;
- meaningful subsystems inspected;
- pages whose bodies changed;
- pages changed only for snapshot header synchronization;
- implementation/test/config evidence used;
- any uncertainty or runtime behavior deliberately not claimed.

If there is no meaningful current-state change, or a full reconciliation finds no correction needed, do not request a PR.