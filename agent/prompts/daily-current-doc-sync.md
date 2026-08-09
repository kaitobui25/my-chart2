# Current documentation semantic synchronization

Maintain the factual body content of the eight human-facing files in `docs/current/` against the repository implementation at `target_sha`.

Runtime context supplies `target_sha`, `baseline_sha`, `synchronization_mode` (`incremental` or `full-reconciliation`) and a `bounded_context` JSON object generated deterministically by `scripts/build-current-doc-context.mjs`.

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

For navigation/search, prefer the built-in Read, Glob and Grep tools. If bash is useful, run one allowed Git command per tool call. Do not combine commands with pipes, `&&`, redirects, environment-variable prefixes, `head`, `grep`, `ls`, `git ls-files`, or other shell utilities.

## Bounded discovery rules

Treat `bounded_context` as the discovery boundary. It contains:

- `changed_paths`: meaningful repository paths changed between baseline and target;
- `semantic_review_docs`: canonical pages whose bodies should be read/reviewed;
- `source_verification_docs`: pages for which implementation evidence should be inspected;
- `evidence_paths`: existing implementation files already cited by canonical docs, sampled deterministically for reconciliation;
- `max_implementation_source_files`: a hard cap on implementation/test/config files you may read during this run.

Hard rules:

1. Never read more implementation/test/config files than `max_implementation_source_files` (currently 25). The eight canonical docs do not count toward this budget.
2. Start source verification with `changed_paths`. Use `evidence_paths` only when needed to verify a claim in `source_verification_docs`.
3. Nearby tests/config may be read only when directly necessary to understand one changed path, and they still count toward the same source-file budget.
4. Do not perform broad repository discovery. In particular, do not use broad Glob patterns such as `**/*`, `examples/**`, `src/**` or `tests/**`.
5. Do not enumerate the whole repository or repeatedly search for additional evidence after the relevant claim is already supported.
6. If the source-file budget is reached, stop discovery. Prefer a smaller, well-supported correction over an exhaustive audit.
7. A page not listed in `source_verification_docs` should not trigger source exploration unless its own text contains an obvious contradiction with `bounded_context`.

## Truth hierarchy

1. implementation at target `main`;
2. tests;
3. runtime configuration, package scripts, migrations and environment examples;
4. merged Git history;
5. existing `docs/current/**`;
6. `agent/plan/**` only as historical intent.

A plan is never proof that a feature is implemented.

## Incremental mode

Use `bounded_context.changed_paths` and `bounded_context.source_verification_docs` as the primary scope. Do not independently rediscover the complete diff unless the supplied context is internally inconsistent.

Read the complete affected implementation file and only the nearby tests/config needed to understand its behavior before editing the routed canonical page. Changes only under `docs/current/**` or historical `agent/plan/**` do not by themselves prove application behavior changed.

Developer automation under `.github/workflows/**`, `agent/opencode/**`, `agent/prompts/**`, or relevant scripts is implementation evidence for `OPERATIONS.md` when it materially changes repository operation or maintenance.

## Full-reconciliation mode

Read the body of each page in `bounded_context.semantic_review_docs` once. This is a semantic drift check, not a license to audit the entire repository.

For source verification:

1. inspect changed implementation/automation paths first;
2. inspect only the pages in `bounded_context.source_verification_docs` against those changes;
3. use `bounded_context.evidence_paths` for spot verification of existing claims, staying within the source-file budget;
4. if a page has no drift signal after that review, leave it unchanged.

If `changed_paths` are only documentation-sync/CI automation, focus source verification on `OPERATIONS.md`, `README.md` and `RECENT_CHANGES.md`. Do not inspect scanner, replay, provider or trading implementation merely because those pages exist.

Do not spend time mechanically rewriting unchanged text. Snapshot metadata/header refresh is not your job.

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

Always consider whether `README.md`, `FEATURES.md` and `RECENT_CHANGES.md` need a semantic body update, but do not open unrelated source files solely to justify that consideration.

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

## Stop condition

As soon as the needed semantic edits are complete:

1. review only the diff of the canonical files you edited;
2. correct unsupported or duplicated claims in that diff if necessary;
3. stop immediately.

Do not start another repository audit, another evidence hunt, or a broad "final verification" pass after the edits are already supported. If no semantic correction/addition is needed, make no edits and finish immediately.
