# Daily Current Documentation Sync V1

## Goal

Create a canonical, code-grounded `docs/current/` snapshot of the implementation on `main`, then keep it synchronized with GitHub Agentic Workflows.

The system must make it possible for a maintainer or coding agent to understand the current project by starting with `docs/current/README.md`, without reconstructing project state from stale plans or long commit history.

## Non-goals

- No TypeDoc.
- No MkDocs or GitHub Pages.
- No DeepWiki.
- No GitHub Wiki.
- Do not rewrite older `agent/plan/*`; those files remain historical intent/design records.
- The documentation agent must never modify application code, package manifests, workflows, tests, migrations, root docs, or historical plans.

## Source-of-truth order

When statements disagree, use this evidence order:

1. Current source code on the target `main` commit.
2. Tests.
3. Runtime configuration, package scripts, migrations, environment examples.
4. Merged PR and commit history.
5. Existing `docs/current/*`.
6. `agent/plan/*` only as historical context.

A plan file is never evidence that a feature is implemented.

## Canonical documentation set

Create:

- `docs/current/README.md` — single entry point and project map.
- `docs/current/ARCHITECTURE.md` — boundaries, ownership, data flows, major modules.
- `docs/current/FEATURES.md` — capability inventory with explicit status/evidence.
- `docs/current/DATA_SOURCES.md` — providers, sidecars, caching, scanner/chart usage.
- `docs/current/SCANNER.md` — scanner pipeline, SQLite, imports, HA, filters, freshness, routing.
- `docs/current/REPLAY.md` — ReplayClock/Session/Projection, caches, HA context, MarketHub/trading behavior.
- `docs/current/OPERATIONS.md` — startup, scripts, ports, sidecars, env, tests, common operational boundaries.
- `docs/current/RECENT_CHANGES.md` — meaningful behavioral/architectural changes, bounded in size.
- `docs/current/_meta.json` — machine checkpoint for incremental synchronization.

Every human-facing page must identify the documented `main` SHA and generation date.

## Phase V1.0 — Bootstrap clean current state

1. Start from current `main` HEAD.
2. Audit current code, tests, runtime configuration, migrations, providers, sidecars, workstation modules and recent merged changes.
3. Build all files under `docs/current/` from implementation evidence.
4. Do not copy historical plans into current docs.
5. Add a small root README pointer to `docs/current/README.md` once; automation will not touch root README afterward.
6. Initialize `_meta.json` with:
   - `schema_version`.
   - `source_branch: main`.
   - `documented_sha`.
   - `generated_at` in Japan time with `+09:00` offset.
   - `mode` (`bootstrap`, `incremental`, or `full-reconciliation`).

Success criterion: reading `docs/current/README.md` plus linked pages is sufficient to orient work on the current repository.

## Phase V1.1 — Deterministic validation

Add `scripts/check-current-docs.mjs`.

Validate at minimum:

- all required canonical files exist;
- `_meta.json` parses and has the required schema;
- `source_branch` is `main`;
- `documented_sha` is a 40-character lowercase Git SHA;
- `documented_sha` exists as a Git commit;
- `documented_sha` is an ancestor of `origin/main` when that ref is available, otherwise of the checked-out HEAD;
- `generated_at` is a valid Japan-time ISO timestamp with explicit `+09:00` offset;
- all human-facing docs contain the same documented SHA;
- every human-facing `Generated` date matches `_meta.json.generated_at`;
- source paths written in backticks and intended as repository evidence resolve when they use known source prefixes;
- `RECENT_CHANGES.md` stays bounded.

The docs CI job must fetch full Git history so commit ancestry checks are meaningful.

## Phase V1.2 — Agentic Workflow safety and rolling PR

Create an Agentic Workflow source and compiled lock workflow.

### Main-only target

The workflow must explicitly check out `main`, not the triggering branch. It must use `origin/main` as `target_sha` and fetch full history plus remote branches needed for rolling PR updates.

Manual execution from GitHub UI must therefore still document `main`, even if the UI or caller would otherwise provide a different triggering ref.

### Hard write boundary

Both code-writing safe outputs must use:

- `protected-files: blocked`;
- `allowed-files: ["docs/current/**"]`.

Historical plans, root docs, source code, package files, tests and `.github/**` stay outside the write boundary.

### PR identity

A docs-sync PR is identified by all of:

- target/base branch `main`;
- title prefix `[docs-sync] `;
- `documentation` label;
- same-repository head branch.

### Rolling PR behavior

Before editing, the agent must inspect open PRs.

- Zero matching PRs: create one new docs-only draft PR if meaningful changes exist.
- Exactly one matching PR: update that PR branch; do not create another.
- More than one matching PR: stop and require human cleanup rather than guessing.

The workflow must use `push-to-pull-request-branch` for the existing rolling PR, with the required title prefix and label enforced by safe-output policy.

When updating an existing rolling PR:

1. inspect target implementation while still on checked-out `main`;
2. get the existing PR's baseline SHA from its branch metadata;
3. only after implementation inspection, switch to the existing PR head branch from the already-fetched remote ref;
4. do **not** merge or rebase main into that branch;
5. edit/commit only `docs/current/**`;
6. push through `push-to-pull-request-branch`;
7. replace the rolling PR body with the latest baseline/target/evidence summary via `update-pull-request`.

This keeps the PR diff docs-only while still documenting the newest main implementation.

## Incremental algorithm

For each run:

1. Resolve `target_sha = origin/main`.
2. Find zero/one valid open rolling docs-sync PR.
3. Read `baseline_sha` from the rolling PR branch when one exists; otherwise from `main`'s `docs/current/_meta.json`.
4. If Monday-Saturday and `baseline_sha == target_sha`, produce no PR/push.
5. Verify baseline is usable; if it cannot safely anchor an incremental comparison, perform full reconciliation instead.
6. Review meaningful implementation changes from `baseline_sha..target_sha`.
7. Ignore changes that only affect `docs/current/**` or `agent/plan/**` when they do not represent implementation changes.
8. Map changed implementation areas to affected docs.
9. Read the full relevant implementation plus tests/config around each changed area from target main; do not document from diff snippets alone.
10. Update only affected current docs plus `README.md`, `FEATURES.md`, `RECENT_CHANGES.md` when the change materially affects them.
11. Set `_meta.json.documented_sha = target_sha` and record generation mode/date.
12. If there is no meaningful documentation change, do not create/update a PR.

## Change-to-doc routing

Use this as routing guidance, not a substitute for reasoning:

- `src/**` -> `FEATURES.md`; `ARCHITECTURE.md` when boundaries/ownership change.
- `examples/providers/**` -> `DATA_SOURCES.md` and operational notes when relevant.
- `examples/sidecars/fiinquant/**` -> `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/vnstock/**` -> `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/scanner/**` -> `SCANNER.md`; `DATA_SOURCES.md` when provider/storage behavior changes.
- `examples/workstation/scanner/**` -> `SCANNER.md`.
- `examples/workstation/replay/**` -> `REPLAY.md`.
- `examples/workstation/trading/**` -> `FEATURES.md`; `REPLAY.md` when replay ownership/quote behavior changes.
- `scripts/**`, `package.json`, env examples -> `OPERATIONS.md`.
- scanner migrations -> `SCANNER.md` / `DATA_SOURCES.md`.

Always consider whether the overview, feature inventory and recent changes also need updating.

## Hallucination guards

- A filename or class existing does not prove production readiness.
- A historical plan does not prove implementation.
- Prefer `implemented`, `verified`, `experimental`, `partial`, `deprecated`, or `unsupported` over vague claims.
- Do not claim runtime verification without runtime/test evidence.
- When evidence is incomplete, say so explicitly.
- Preserve raw market data versus derived/display data distinctions.
- Source paths used as evidence should be concrete and current.

## Weekly self-healing reconciliation

After unattended scheduling is enabled:

- Monday-Saturday: incremental synchronization.
- Sunday: full current-state reconciliation against implementation, using old docs only as a comparison target.

This prevents small incremental documentation mistakes from accumulating indefinitely.

## PR body

Each new or rolling PR state should report:

- baseline SHA;
- target SHA;
- mode;
- affected subsystems;
- docs whose bodies changed;
- docs changed only for snapshot-header synchronization;
- implementation/test/config evidence considered;
- uncertainty/runtime behavior deliberately not claimed.

## Phase V1.3 — Manual-first rollout

The initial merged workflow must be **manual-only** using `workflow_dispatch`. Do not enable unattended schedule in the same rollout PR.

Before daily scheduling:

1. Compile and strict-validate the Agentic Workflow.
2. Merge the manual-only workflow to default branch.
3. Run it manually against real repository state.
4. Inspect any resulting docs-only draft PR, or verify a correct no-op when main has no meaningful undocumented change.
5. On the first real follow-up implementation change, verify the same rolling PR is updated rather than a second PR being created.
6. Verify safe-output allowlists reject paths outside `docs/current/**`.
7. Tune prompts if current-state claims are unsupported or noisy.

## CI trigger prerequisite for unattended operation

GitHub Actions intentionally does not trigger normal CI from PR/push events performed with the default Actions `GITHUB_TOKEN`.

Before daily operation, configure repository secret:

```text
GH_AW_CI_TRIGGER_TOKEN
```

It must be a suitably scoped fine-grained PAT (or equivalent supported auth) that can perform the extra empty commit used by gh-aw to trigger normal PR/push CI.

Do not enable unattended daily operation until docs-sync PRs reliably run the deterministic docs checker and normal repository CI.

## Phase V1.4 — Daily operation

Only after the manual rollout and CI-trigger prerequisite are verified, make a small follow-up change that enables daily + manual triggering.

Then monitor the first 7-14 documentation PR updates for:

- unsupported feature claims;
- lost valid information;
- wrong subsystem routing;
- broken source references;
- unnecessary rewrites;
- stale baseline handling;
- accidental duplicate docs-sync PRs;
- missing CI runs.

## Phase V2 — Deterministic auto-merge (deferred)

Do not implement auto-merge until the prompt has demonstrated stable behavior across at least 7-14 reviewed updates.

When enabled later, merge eligibility must be deterministic and require:

- `[docs-sync]` identity plus `documentation` label;
- only `docs/current/**` changed;
- current-doc checker passing;
- required repository CI passing;
- no blocking review state;
- documented target SHA still valid for the intended main state.

The AI agent never decides to merge.

## Security model

- Agent reasoning is read-only.
- Writes are handled through Agentic Workflow safe outputs.
- `allowed-files` is the hard boundary, not prompt obedience.
- Automation never receives permission to modify workflow files or application code through its safe outputs.
- Rolling PR updates are constrained by both title prefix and label.
- Auto-merge, if enabled in V2, is a separate deterministic mechanism.

## Delivery definition

The implementation PR is ready to merge when:

1. Canonical current docs are bootstrapped from the current `main` implementation.
2. `_meta.json` records a trustworthy baseline.
3. Deterministic docs validation is in CI and checks Git ancestry/date consistency.
4. Agentic Workflow source and compiled workflow are strict-valid.
5. Workflow checkout is pinned to `main`.
6. Rolling PR create/update safe outputs are configured with a docs-only allowlist.
7. The rollout trigger is manual-only.
8. Historical `agent/plan/*` files remain untouched except for this new plan document.

Live manual/staged behavior and CI-trigger auth are post-merge rollout gates before enabling the daily schedule.
