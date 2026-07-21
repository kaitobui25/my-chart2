# L2Chart examples

Everything in this directory is optional and excluded from the published
`lamlong-chart` package.

- `workstation/` is the complete browser demo and application composition root.
- `providers/` contains reference implementations of the provider-neutral
  `Datafeed` contract.
- `sidecars/` contains optional backend integration examples used by selected
  providers.

Provider names, authentication flows, paper trading, and application UI belong
here rather than in `src/`. Consumers can copy, replace, or remove these
examples without changing the chart core.
