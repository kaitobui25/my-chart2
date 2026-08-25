export type ChartLocale = 'en' | 'vi';

const ENGLISH: Record<string, string> = {
  'Cấu hình chỉ báo': 'Indicator settings',
  'Cấu hình': 'Settings',
  'Chỉ số hóa 100': 'Indexed to 100',
  'Hiện chỉ báo': 'Show indicator',
  'Hiện các dòng chỉ báo': 'Show indicator rows',
  'Ẩn chỉ báo': 'Hide indicator',
  'Ẩn các dòng chỉ báo': 'Hide indicator rows',
  'Đảo chiều trục': 'Invert scale',
  'Đặt lại tỷ lệ giá': 'Reset price scale',
  'Đặt lại khung nhìn': 'Reset view',
  'Logarit': 'Logarithmic',
  'Phần trăm': 'Percent',
  'Thường': 'Regular',
  'Tự động vừa dữ liệu': 'Auto fit data',
  'Xóa chỉ báo': 'Remove indicator',
  'Xóa': 'Remove',
  'Ghi chú': 'Note',
  'Ý tưởng': 'Idea',
  'Bài viết': 'Post',
  'Mức': 'Level',
  'Hỗ trợ': 'Support',
  'Kháng cự': 'Resistance',
  'Đang tải ảnh': 'Loading image',
  'Chưa có URL ảnh': 'No image URL',
  'Mục tiêu': 'Target',
  'Vào lệnh': 'Entry',
  'Dừng': 'Stop',
  'nến': 'bars',
};

let locale: ChartLocale = 'en';

try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('l2chart.locale') === 'vi') {
    locale = 'vi';
  }
} catch {
  // Storage access is optional for embedded and server-rendered consumers.
}

export function getChartLocale(): ChartLocale {
  return locale;
}

export function setChartLocale(next: ChartLocale): void {
  locale = next;
}

export function tr(source: string): string {
  return locale === 'en' ? (ENGLISH[source] ?? source) : source;
}
