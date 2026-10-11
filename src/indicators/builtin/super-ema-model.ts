import type { Candle, LinePoint } from '../../core/types';
import { ema, type Source } from '../index';

export interface EmaOptions {
  length: number;
  source: Source;
  visible: boolean;
  color: string;
  width: number;
}
export type Alignment = 'bull' | 'bear' | 'neutral' | 'warming';
export interface SuperEmaResult {
  lines: LinePoint[][];
  states: Alignment[];
  signals: { index: number; state: 'bull' | 'bear' }[];
}

/** A following bar confirms closure; the final bar never emits a signal. */
export function calculateSuperEma(candles: readonly Candle[], options: readonly EmaOptions[]): SuperEmaResult {
  const lines = options.map(option => ema(candles, option.length, option.source));
  const states: Alignment[] = candles.map((_, index) => {
    const values = lines.map(line => line[index]);
    if (values.some(value => value === null)) return 'warming';
    if (values.every((value, i) => i === 0 || values[i - 1]! > value!)) return 'bull';
    if (values.every((value, i) => i === 0 || values[i - 1]! < value!)) return 'bear';
    return 'neutral';
  });
  const signals: SuperEmaResult['signals'] = [];
  for (let index = 0; index < candles.length - 1; index++) {
    const state = states[index];
    if ((state === 'bull' || state === 'bear') && states[index - 1] !== state) signals.push({ index, state });
  }
  return { lines, states, signals };
}
