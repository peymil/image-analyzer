import { numberLocale, t } from './i18n';

const MB = 1024 * 1024;

export function fmtFixed(value: number, digits: number): string {
  return value.toLocaleString(numberLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtMB(bytes: number): string {
  return `${fmtFixed(bytes / MB, 2)} MB`;
}

export function fmtKB(bytes: number): string {
  return t('units.kb', { value: fmtFixed(bytes / 1024, 0) });
}

export function fmtBytes(bytes: number): string {
  return t('units.bytes', { value: fmtNum(bytes) });
}

export function fmtPct(pct: number): string {
  return `${fmtFixed(pct, 1)}%`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString(numberLocale());
}

export function fmtSec(ms: number): string {
  return t('units.seconds', { value: fmtFixed(ms / 1000, 1) });
}

export function fmtMs(ms: number): string {
  return t('units.milliseconds', { value: fmtFixed(ms, 0) });
}

/** Kalite yorumunun çeviri anahtarı. PSNR eşikleri sezgiseldir; son karar göz kontrolüyle verilmelidir. */
export function psnrVerdictKey(psnr: number): string {
  if (!Number.isFinite(psnr)) return 'quality.verdictLossless';
  if (psnr >= 45) return 'quality.verdictGood';
  if (psnr >= 38) return 'quality.verdictAcceptable';
  return 'quality.verdictRisky';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
