# Local indicators

This directory is reserved for local indicator modules that should not be
committed. Git ignores every file here except this README.

Create a TypeScript module that exports an `IndicatorDef`. The workstation
discovers it automatically during development:

```ts
// src/indicators/custom/example.ts
import type { IndicatorDef } from '../registry';
import { sma } from '../index';

const example: IndicatorDef = {
  id: 'local-example',
  name: 'Local Example',
  category: 'custom',
  create(chart) {
    const series = chart.addLine({ title: 'Local Example', color: '#f472b6' });
    return {
      recompute: () => series.setData(sma(chart.getCandles(), 9)),
      remove: () => chart.removeSeries(series),
    };
  },
};

export default example;
```

Move an indicator into `src/indicators/builtin/` and import it from
`src/indicators/all.ts` before contributing it to the public registry. Only
submit implementations whose source and license can be verified.
