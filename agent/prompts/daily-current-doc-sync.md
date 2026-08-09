# Current documentation semantic synchronization

Maintain the factual body content of the eight human-facing files in `docs/current/` against the repository implementation at `target_sha`.

Runtime context supplies `target_sha`, `baseline_sha`, and `synchronization_mode` (`incremental` or `full-reconciliation`).

## Hard boundaries

You may edit only:

- `docs/current/README.md`
- `docs/current/ARCHITECTURE.md`
- `docs/current/FEATURES.md`
- `docs/current/DATA_SOURCES.md`
- `docs/current/SCANNER.md`
- `docs/current/REPLAY.md`
- `docs/current/OPERATIONS.md`
- `docs/current/RECENT_CHANGES.md`

Do not edit `docs/current/_meta.json`. Do not edit the `Generated` or `Documented main` header lines. The workflow synchronizes snapshot metadata and headers deterministically after you finish.

Do not create files, commit, push, manage pull requests, change Git configuration, or use the web.

For navigation/search, prefer the built-in Read, Glob and Grep tools. If bash is useful, run one allowed Git command per tool call. Do not combine commands with pipes, `&&`, redirects, environment-variable prefixes, `head`, `grep`, `ls`, or other shell utilities.

## Truth hierarchy

1. implementation at target `main`;
2. tests;
3. runtime configuration, package scripts, migrations and environment examples;
4. merged Git history;
5. existing `docs/current/**`;
6. `agent/plan/**` only as historical intent.

A plan is never proof that a feature is implemented.

## Incremental mode

Start with these as separate bash calls:

```bash
git diff --name-status <baseline_sha>..<target_sha>
git log --oneline <baseline_sha>..<target_sha>
```

Identify meaningful implementation changes, then read the complete affected implementation and nearby tests/configuration before editing documentation. Changes only under `docs/current/**` or historical `agent/plan/**` do not by themselves prove application behavior changed.

Developer automation under `.github/workflows/**`, `agent/opencode/**`, `agent/prompts/**`, or relevant scripts is implementation evidence for `OPERATIONS.md` when it materially changes repository operation or maintenance.

## Full-reconciliation mode

Audit the semantic claims in all eight canonical pages against current source/tests/config at `target_sha`. Focus on claims likely to become stale: ownership boundaries, runtime flows, provider/cache behavior, scanner/replay behavior, startup/operations and current limitations.

Do not spend time mechanically rewriting unchanged text. If a page body is already accurate, leave its body alone. Snapshot metadata/header refresh is not your job.

## Routing guidance

- `src/**` -> `FEATURES.md`; `ARCHITECTURE.md` when boundaries/ownership change.
- `examples/providers/**` -> `DATA_SOURCES.md`; operations when startup/cache behavior changes.
- `examples/sidecars/fiinquant/**` -> `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/vnstock/**` -> `DATA_SOURCES.md`, `OPERATIONS.md`.
- `examples/sidecars/scanner/**` -> `SCANNER.md`; `DATA_SOURCES.md` for source/storage changes.
- `examples/workstation/scanner/**` -> `SCANNER.md`.
- `examples/workstation/replay/**` -> `REPLAY.md`.
- `examples/workstation/trading/**` -> `FEATURES.md`; `REPLAY.md` when replay/quote ownership changes.
- `scripts/**`, `package.json`, environment examples -> `OPERATIONS.md`.
- `.github/workflows/**`, `agent/opencode/**`, `agent/prompts/**` -> `OPERATIONS.md` for meaningful automation changes.
- scanner migrations -> `SCANNER.md` and, when storage/source meaning changes, `DATA_SOURCES.md`.

Always consider whether `README.md`, `FEATURES.md` and `RECENT_CHANGES.md` need a semantic body update.

## Documentation rules

- Describe current behavior, not future intent.
- Prefer explicit statuses: `Verified`, `Implemented`, `Experimental`, `Partial`, `Deprecated`, `Unsupported`.
- Do not claim runtime verification without source/tests/config/runtime evidence.
- Preserve raw market OHLC vs derived Heikin Ashi distinctions.
- Preserve browser/provider history cache vs scanner SQLite storage distinctions.
- Preserve the `vn_eod` invariant: scanner execution is preloaded/local; CafeF ingestion is a separate import step.
- Keep useful limitations when still true.
- Keep evidence paths concrete and current.
- Keep `RECENT_CHANGES.md` meaningful and bounded; do not turn it into a commit dump.

Before finishing, review only the semantic body edits you made for unsupported or duplicated claims. If no semantic correction/addition is needed, make no edits.
