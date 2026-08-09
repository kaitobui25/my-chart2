# Daily Current Documentation Sync V1

## Goal

Create a canonical, code-grounded `docs/current/` snapshot of the implementation on `main`, then keep it synchronized once per day with GitHub Agentic Workflows.

The system must make it possible for a maintainer or coding agent to understand the current project by starting with `docs/current/README.md`, without reconstructing project state from stale plans or long commit history.

## Non-goals

- No TypeDoc.
- No MkDocs or GitHub Pages.
- No DeepWiki.
- No GitHub Wiki.
- Do not rewrite `agent/plan/*`; those files remain historical intent/design records.
- The documentation agent must never modify application code, package manifests, workflows, tests, migrations, or historical plans.

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
5. Add a small root README pointer to `docs/current/README.md` once; daily automation will not touch root README afterward.
6. Initialize `_meta.json` with:
   - `schema_version`.
   - `documented_sha`.
   - `generated_at`.
   - `mode` (`bootstrap`, `incremental`, or `full-reconciliation`).

Success criterion: reading `docs/current/README.md` plus linked pages is sufficient to orient work on the current repository.

## Phase V1.1 — Deterministic validation

Add `scripts/check-current-docs.mjs`.

Validate at minimum:

- all required canonical files exist;
- `_meta.json` parses and has the required schema;
- `documented_sha` is a 40-character lowercase Git SHA;
- human-facing docs contain the same documented SHA;
- source paths written in backticks and intended as repository evidence resolve when they use known source prefixes;
- `RECENT_CHANGES.md` stays bounded;
- docs do not accidentally claim a future/nonexistent metadata format.

Add the checker to CI as a lightweight docs job. Keep existing core/browser/sidecar/security checks unchanged.

## Phase V1.2 — Daily Agentic Workflow

Create an Agentic Workflow source and compiled lock workflow.

Triggers:

- daily schedule at an off-peak minute;
- manual `workflow_dispatch`.

Permissions:

- agent side remains read-only;
- safe output may create at most one draft PR.

Hard write boundary:

- `allowed-files: ["docs/current/**"]` for agent-created patches;
- historical plans, root docs, source code, package files, tests and `.github/**` are outside the allowlist.

PR policy:

- title prefix `[docs-sync]`;
- label `docs-auto-sync` when available;
- draft PR initially;
- no direct push to `main`;
- no AI-controlled merge.

## Incremental algorithm

For each daily run:

1. Resolve current `main` HEAD as `target_sha`.
2. Read `docs/current/_meta.json` to get `baseline_sha`.
3. If `baseline_sha == target_sha`, produce no PR.
4. Verify baseline is usable; if it cannot safely anchor an incremental comparison, perform full reconciliation instead.
5. Review meaningful changes from `baseline_sha..target_sha`.
6. Ignore changes that only affect `docs/current/**` or `agent/plan/**` when they do not represent implementation changes.
7. Map changed implementation areas to affected docs.
8. Read the full relevant implementation plus tests/config around each changed area; do not document from diff snippets alone.
9. Update only affected current docs plus `README.md`, `FEATURES.md`, `RECENT_CHANGES.md` when the change materially affects them.
10. Set `_meta.json.documented_sha = target_sha` and record generation mode/date.
11. If there is no meaningful documentation change, do not create a PR.

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

Use the same once-daily workflow:

- Monday-Saturday: incremental synchronization.
- Sunday: full current-state reconciliation against implementation, using old docs only as a comparison target.

This prevents small incremental documentation mistakes from accumulating indefinitely.

## PR behavior

Initial rollout uses draft PRs for human review.

Each PR body should report:

- baseline SHA;
- target SHA;
- mode;
- affected subsystems;
- docs changed;
- docs intentionally unchanged;
- implementation/test/config evidence considered.

A future rolling-PR enhancement may update an already-open `[docs-sync]` PR instead of opening another. It is optional for initial V1 if safe-output semantics make a single fresh PR simpler and more reliable.

## Phase V1.3 — Staged/manual verification

Before enabling unattended daily updates:

1. Compile the Agentic Workflow using the supported `gh aw` tooling.
2. Run safe outputs in staged/manual mode and inspect the proposed patch.
3. Run one real manual draft docs PR.
4. Verify `allowed-files` rejects attempted changes outside `docs/current/**`.
5. Tune prompts if current-state claims are unsupported or noisy.

## Phase V1.4 — Daily operation

Enable the daily schedule only after the manual run is correct.

Monitor the first 7-14 documentation PRs for:

- unsupported feature claims;
- lost valid information;
- wrong subsystem routing;
- broken source references;
- unnecessary rewrites;
- stale baseline handling.

## Phase V2 — Deterministic auto-merge (deferred)

Do not implement auto-merge until the prompt has demonstrated stable behavior across at least 7-14 reviewed runs.

When enabled later, merge eligibility must be deterministic and require:

- `[docs-sync]` identity/label;
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
- Daily automation never receives permission to modify workflow files or application code.
- Auto-merge, if enabled in V2, is a separate deterministic mechanism.

## Delivery definition

V1 is complete when:

1. Canonical current docs are bootstrapped from the current `main` implementation.
2. `_meta.json` records a trustworthy baseline.
3. Deterministic docs validation is in CI.
4. Agentic Workflow source and compiled workflow are valid.
5. Manual/staged validation passes.
6. The daily run can create a docs-only draft PR when implementation changes and do nothing when nothing meaningful changed.
7. Historical `agent/plan/*` files remain untouched except for this new plan document.