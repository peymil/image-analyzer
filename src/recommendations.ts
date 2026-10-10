// Analiz ve varyant sonuçlarından öneri ve skor üretir. Metinler çeviri anahtarı + parametre olarak döner.
import type { ImageAnalysis } from './pipeline/analyze';
import type { VariantId, VariantResult } from './types';
import { fmtFixed, fmtMB, fmtNum, fmtPct, psnrVerdictKey } from './format';
import { t, type Params } from './i18n';

export type Severity = 'high' | 'medium' | 'low' | 'info';
export type Risk = 'lossless' | 'lossy' | 'info';

export interface Recommendation {
  severity: Severity;
  risk: Risk;
  titleKey: string;
  titleParams?: Params;
  detailKey: string;
  detailParams?: Params;
  /** Tahmini kazanç (bayt). */
  savingBytes?: number;
  variantId?: VariantId;
}

export interface Recommendations {
  items: Recommendation[];
  score: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
const SEVERITY_PENALTY: Record<Severity, number> = { high: 20, medium: 10, low: 3, info: 0 };

export const UNITY_MAX_SIZE = 2048;

function isPowerOfTwo(v: number): boolean {
  return v > 0 && (v & (v - 1)) === 0;
}

export function colorTypeKey(colorType: number): string {
  return [0, 2, 3, 4, 6].includes(colorType) ? `colorType.${colorType}` : 'colorType.unknown';
}

export function buildRecommendations(a: ImageAnalysis, variants: VariantResult[]): Recommendations {
  const recs: Recommendation[] = [];
  const find = (id: VariantId) => variants.find((v) => v.id === id);
  const lossless = find('lossless');
  const p256 = find('palette256');
  const orig = a.fileSize;
  const declaredAlpha = a.structure.colorType === 4 || a.structure.colorType === 6;
  const n = a.pixelCount;

  if (orig > 5 * 1024 * 1024) {
    recs.push({
      severity: 'high',
      risk: 'info',
      titleKey: 'rec.bigFile.title',
      titleParams: { size: fmtMB(orig) },
      detailKey: 'rec.bigFile.detail',
    });
  }

  if (declaredAlpha && a.alpha.allOpaque) {
    recs.push({
      severity: 'medium',
      risk: 'lossless',
      titleKey: 'rec.noAlpha.title',
      detailKey: 'rec.noAlpha.detail',
      detailParams: { colorType: t(colorTypeKey(a.structure.colorType)) },
      savingBytes: lossless ? orig - lossless.sizeBytes : undefined,
      variantId: 'lossless',
    });
  }

  if (!a.alpha.allOpaque && a.alpha.transparent > 0 && a.hiddenRgb / a.alpha.transparent > 0.05) {
    recs.push({
      severity: 'medium',
      risk: 'lossless',
      titleKey: 'rec.hiddenRgb.title',
      detailKey: 'rec.hiddenRgb.detail',
      detailParams: {
        count: fmtNum(a.alpha.transparent),
        pct: fmtPct((a.hiddenRgb / a.alpha.transparent) * 100),
      },
      variantId: 'lossless',
    });
  }

  if (a.alpha.faint / n > 0.02) {
    const faint0 = find('faint0');
    recs.push({
      severity: 'low',
      risk: 'lossy',
      titleKey: 'rec.faint.title',
      titleParams: { pct: fmtPct((a.alpha.faint / n) * 100) },
      detailKey: 'rec.faint.detail',
      savingBytes: faint0 ? orig - faint0.sizeBytes : undefined,
      variantId: 'faint0',
    });
  }

  const partialShare = (a.alpha.partial / n) * 100;
  if (partialShare > 30) {
    recs.push({
      severity: 'low',
      risk: 'info',
      titleKey: 'rec.partial.title',
      titleParams: { pct: fmtPct(partialShare) },
      detailKey: 'rec.partial.detail',
    });
  }

  if (a.colors.uniqueVisibleRgb > 256) {
    const saving = p256 ? orig - p256.sizeBytes : undefined;
    recs.push({
      severity: 'medium',
      risk: 'lossy',
      titleKey: 'rec.manyColors.title',
      titleParams: { count: fmtNum(a.colors.uniqueVisibleRgb) },
      detailKey: p256?.quality ? 'rec.manyColors.detail' : 'rec.manyColors.noQuality',
      detailParams: p256?.quality
        ? {
            size: fmtMB(p256.sizeBytes),
            saving: `${fmtMB(saving!)} (${fmtPct((saving! / orig) * 100)})`,
            psnr: fmtFixed(p256.quality.psnr, 1),
            verdict: t(psnrVerdictKey(p256.quality.psnr)),
          }
        : undefined,
      savingBytes: saving,
      variantId: 'palette256',
    });
  } else if (a.colors.uniqueVisibleRgb > 0) {
    recs.push({
      severity: 'low',
      risk: 'lossless',
      titleKey: 'rec.fewColors.title',
      titleParams: { count: fmtNum(a.colors.uniqueVisibleRgb) },
      detailKey: 'rec.fewColors.detail',
      variantId: 'palette256',
    });
  }

  if (a.colors.grayscale && a.structure.colorType !== 0 && a.structure.colorType !== 4) {
    recs.push({
      severity: 'low',
      risk: 'info',
      titleKey: 'rec.grayscale.title',
      detailKey: 'rec.grayscale.detail',
    });
  }

  const metaChunks = a.structure.chunks
    .map((c) => c.type)
    .filter((tp) => !['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS', 'pHYs'].includes(tp));
  if (metaChunks.length > 0 || a.structure.hasIcc) {
    recs.push({
      severity: 'low',
      risk: 'lossless',
      titleKey: 'rec.metadata.title',
      titleParams: { list: [...new Set(metaChunks)].join(', ') || 'iCCP' },
      detailKey: 'rec.metadata.detail',
      variantId: 'lossless',
    });
  }

  const maxSide = Math.max(a.width, a.height);
  if (maxSide > UNITY_MAX_SIZE) {
    recs.push({
      severity: 'medium',
      risk: 'info',
      titleKey: 'rec.maxSize.title',
      titleParams: { max: UNITY_MAX_SIZE, w: a.width, h: a.height },
      detailKey: 'rec.maxSize.detail',
    });
  }

  if (!isPowerOfTwo(a.width) || !isPowerOfTwo(a.height)) {
    recs.push({
      severity: 'low',
      risk: 'info',
      titleKey: 'rec.npot.title',
      detailKey: 'rec.npot.detail',
    });
  }

  if (lossless && (orig - lossless.sizeBytes) / orig > 0.02) {
    const saving = orig - lossless.sizeBytes;
    recs.push({
      severity: 'high',
      risk: 'lossless',
      titleKey: 'rec.losslessSaving.title',
      titleParams: { saving: fmtMB(saving), pct: fmtPct((saving / orig) * 100) },
      detailKey: 'rec.losslessSaving.detail',
      detailParams: { before: fmtMB(orig), after: fmtMB(lossless.sizeBytes) },
      savingBytes: saving,
      variantId: 'lossless',
    });
  }

  recs.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);

  const penalty = recs.reduce((s, r) => s + SEVERITY_PENALTY[r.severity], 0);
  return { items: recs, score: Math.max(0, 100 - penalty) };
}
