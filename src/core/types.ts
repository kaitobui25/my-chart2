/** A single OHLCV bar. `time` is a unix timestamp in seconds (bar open time). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Indicator/line value aligned to the candle at the same index; null = no value (warm-up). */
export type LinePoint = number | null;

export interface Theme {
  bg: string;
  text: string;
  textDim: string;
  grid: string;
  border: string;
  axisBg: string;
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  volUp: string;
  volDown: string;
  crosshair: string;
  crosshairLabelBg: string;
  crosshairLabelText: string;
  lastPriceUpBg: string;
  lastPriceDownBg: string;
  /** Measure tool (Shift+drag): base color and tooltip text color per direction. */
  measureUp: string;
  measureUpText: string;
  measureDown: string;
  measureDownText: string;
  /** Default rotation palette for indicator lines. */
  palette: string[];
}

export const darkTheme: Theme = {
  bg: '#0a0d0f',
  text: '#edf1f3',
  textDim: '#87939a',
  grid: 'rgba(226, 234, 238, 0.045)',
  border: '#242b30',
  axisBg: '#0a0d0f',
  up: '#00b887',
  down: '#f04455',
  wickUp: '#00d09a',
  wickDown: '#ff5868',
  volUp: 'rgba(50, 201, 143, 0.26)',
  volDown: 'rgba(239, 98, 98, 0.26)',
  crosshair: '#93a1aa',
  crosshairLabelBg: '#344047',
  crosshairLabelText: '#ffffff',
  lastPriceUpBg: '#32c98f',
  lastPriceDownBg: '#ef6262',
  measureUp: '#67d8ff',
  measureUpText: '#07151d',
  measureDown: '#ff6f87',
  measureDownText: '#ffffff',
  palette: ['#3b82f6', '#f4b740', '#22d3ee', '#a78bfa', '#2dd4bf', '#fb7185'],
};

export const lightTheme: Theme = {
  bg: '#ffffff',
  text: '#1a212b',
  textDim: '#75818f',
  grid: 'rgba(26, 33, 43, 0.06)',
  border: '#dbe0e8',
  axisBg: '#ffffff',
  up: '#008f69',
  down: '#d92f45',
  wickUp: '#007f5d',
  wickDown: '#c6283d',
  volUp: 'rgba(29, 157, 111, 0.3)',
  volDown: 'rgba(224, 69, 69, 0.3)',
  crosshair: '#8b97a5',
  crosshairLabelBg: '#1a212b',
  crosshairLabelText: '#ffffff',
  lastPriceUpBg: '#1d9d6f',
  lastPriceDownBg: '#e04545',
  measureUp: '#16769b',
  measureUpText: '#ffffff',
  measureDown: '#d83b55',
  measureDownText: '#ffffff',
  palette: ['#2563eb', '#d99a16', '#0891b2', '#7c3aed', '#0f9f88', '#e44f69'],
};
