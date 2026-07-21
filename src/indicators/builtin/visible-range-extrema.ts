import type { IndicatorDef } from '../registry';
import { getChartLocale } from '../../core/i18n';

const vi = getChartLocale() === 'vi';

const def: IndicatorDef = {
  id: 'visible-range-extrema',
  name: vi ? 'Cao/Thấp vùng nhìn thấy' : 'Visible Range High/Low',
  category: 'overlay',
  order: 2,
  create(chart) {
    const series = chart.addVisibleRangeExtrema({
      title: vi ? 'Cao/Thấp vùng' : 'Visible range High/Low',
      highLabel: vi ? 'Cao' : 'High',
      lowLabel: vi ? 'Thấp' : 'Low',
    });
    return {
      recompute: () => chart.invalidate(),
      remove: () => chart.removeSeries(series),
    };
  },
};

export default def;
