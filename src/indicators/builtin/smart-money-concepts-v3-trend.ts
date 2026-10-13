import type { RenderContext } from '../../core/series';
import type { SmcV2BarState } from './smart-money-concepts-v2-model';

type StructureBias = SmcV2BarState['bias'];

/** Two structure sizes on the chart timeframe, not independent market timeframes. */
export function alignedStructureBias(internal: StructureBias, swing: StructureBias): StructureBias {
  return internal !== 0 && internal === swing ? internal : 0;
}

export function drawAlignedStructureBackground(
  rc: RenderContext,
  states: readonly SmcV2BarState[],
  colors: { bullish: string; bearish: string; opacity: number },
): void {
  const alpha = Math.max(0, Math.min(100, colors.opacity)) / 100;
  if (alpha === 0) return;

  const { ctx, ts } = rc;
  for (let index = Math.max(0, rc.from); index <= rc.to && index < states.length; index++) {
    const { internalBias, bias } = states[index];
    const aligned = alignedStructureBias(internalBias, bias);
    if (aligned === 0) continue;

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = aligned === 1 ? colors.bullish : colors.bearish;
    ctx.fillRect(ts.xForIndex(index) - ts.barSpacing / 2, 0, ts.barSpacing, rc.paneHeight);
    ctx.restore();
  }
}
