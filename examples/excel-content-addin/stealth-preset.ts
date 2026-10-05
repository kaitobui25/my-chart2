import { lightTheme, type ChartOptions, type Theme } from '../../src/library';
import type { CandleRangeOptions } from './ohlc-range';

export const excelStealthTheme: Theme = {
  ...lightTheme,
  bg: '#ffffff',
  text: '#3f474c',
  textDim: '#8a9297',
  grid: 'rgba(176, 182, 186, 0.38)',
  border: '#e4e6e8',
  axisBg: '#ffffff',
  up: '#74838c',
  down: '#939ba0',
  wickUp: '#a8b0b5',
  wickDown: '#a8b0b5',
  volUp: 'rgba(116, 131, 140, 0.10)',
  volDown: 'rgba(147, 155, 160, 0.10)',
  crosshair: '#b8c0c5',
  crosshairLabelBg: '#f3f5f6',
  crosshairLabelText: '#50585d',
  lastPriceUpBg: '#8b989f',
  lastPriceDownBg: '#8b989f',
  measureUp: '#8b989f',
  measureUpText: '#ffffff',
  measureDown: '#8b989f',
  measureDownText: '#ffffff',
  palette: ['#7d8b93', '#9aa3a8', '#b0b7bb', '#87949b', '#a4adb2', '#727f86'],
};

export const excelStealthChartOptions: ChartOptions = {
  theme: excelStealthTheme,
  cursor: 'cell',
  candleRendering: {
    bodyWidthRatio: 0.4,
    minBodyWidth: 1,
    maxBodyWidth: 3,
    hollowUp: true,
    hollowDown: false,
    baseOpacity: 0.18,
    focusOpacity: 0.72,
    focusRadius: 2,
    minWickSpacing: 1.2,
  },
  chrome: {
    grid: true,
    priceAxis: false,
    timeAxis: false,
    legend: false,
    crosshair: false,
    lastPrice: false,
    sessionBands: false,
  },
};

export const excelRangeOptions: CandleRangeOptions = {
  numericTimeFormat: 'auto',
};

export const excelStealthUi = Object.freeze({
  ready: 'Sẵn sàng',
  loading: 'Đang đọc vùng chọn…',
  preview: 'Preview dữ liệu mẫu',
  emptyRange: 'Không tìm thấy dòng OHLC hợp lệ trong vùng chọn.',
  genericError: 'Không thể đọc dữ liệu từ Excel.',
});
