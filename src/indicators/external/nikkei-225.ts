import { createComparisonOverlay } from './comparison-overlay';
/** Fixed-index configuration of the shared comparison renderer. */
export { drawComparisonOverlay as drawNikkeiCandles } from './comparison-overlay';
export default createComparisonOverlay({ id: 'nikkei-225', name: 'Nikkei 225', symbol: '^N225' });
