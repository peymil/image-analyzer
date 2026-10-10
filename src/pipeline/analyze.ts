// Piksel tabanlı analiz: alfa dağılımı, gizli RGB, renk sayısı ve kapsama eğrisi.
import type { PngStructure } from './png-parse';

/** Bu değerin altındaki (1..3) alfa değerleri gözle neredeyse görünmez kabul edilir. */
export const FAINT_MAX_ALPHA = 3;

export interface ColorStat {
  hex: string;
  count: number;
}

export interface CoveragePoint {
  colors: number;
  pct: number;
}

export interface ImageAnalysis {
  fileName: string;
  fileSize: number;
  /** Analiz edilen (gerekirse küçültülmüş) boyutlar. */
  width: number;
  height: number;
  /** Yükleme öncesi küçültme katsayısı (1 = yok) ve özgün boyutlar. */
  downscale: number;
  sourceWidth: number;
  sourceHeight: number;
  pixelCount: number;
  structure: PngStructure;
  alpha: {
    opaque: number;
    transparent: number;
    partial: number;
    faint: number;
    allOpaque: boolean;
    histogram: number[];
  };
  /** Tamamen saydam (alfa=0) pikseller içinde RGB'si sıfır olmayanların sayısı. */
  hiddenRgb: number;
  colors: {
    uniqueRgba: number;
    uniqueVisibleRgb: number;
    grayscale: boolean;
    top: ColorStat[];
    coverage90: number;
    coverage95: number;
    coverage99: number;
    curve: CoveragePoint[];
  };
  analysisMs: number;
}

function countUnique(sorted: Uint32Array): number {
  let unique = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) unique++;
  }
  return unique;
}

function runLengths(sorted: Uint32Array): { keys: number[]; counts: number[] } {
  const keys: number[] = [];
  const counts: number[] = [];
  let i = 0;
  while (i < sorted.length) {
    const k = sorted[i];
    let j = i + 1;
    while (j < sorted.length && sorted[j] === k) j++;
    keys.push(k);
    counts.push(j - i);
    i = j;
  }
  return { keys, counts };
}

export interface AnalyzeInput {
  fileName: string;
  fileSize: number;
  structure: PngStructure;
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Yükleme öncesi küçültme katsayısı (1 = yok). */
  downscale: number;
  sourceWidth: number;
  sourceHeight: number;
}

export function analyzeImage(input: AnalyzeInput): ImageAnalysis {
  const started = performance.now();
  const { rgba, width, height } = input;
  const n = width * height;

  const histogram = new Array<number>(256).fill(0);
  let opaque = 0;
  let transparent = 0;
  let partial = 0;
  let faint = 0;
  let hiddenRgb = 0;
  const allKeys = new Uint32Array(n);
  const visible = new Uint32Array(n);
  let vn = 0;
  let grayscale = true;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    histogram[a]++;
    if (a === 255) {
      opaque++;
    } else if (a === 0) {
      transparent++;
      if ((r | g | b) !== 0) hiddenRgb++;
    } else {
      partial++;
    }
    if (a > 0 && a <= FAINT_MAX_ALPHA) faint++;
    allKeys[i] = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (a > 0) {
      visible[vn++] = ((r << 16) | (g << 8) | b) >>> 0;
      if (r !== g || g !== b) grayscale = false;
    }
  }

  allKeys.sort();
  const uniqueRgba = countUnique(allKeys);

  const vis = visible.subarray(0, vn).sort();
  const runs = runLengths(vis);
  const uniqueVisibleRgb = runs.keys.length;

  const order = Array.from(runs.counts.keys()).sort((x, y) => runs.counts[y] - runs.counts[x]);
  const top = order.slice(0, 16).map((i) => ({
    hex: '#' + runs.keys[i].toString(16).padStart(6, '0'),
    count: runs.counts[i],
  }));

  // Kapsama: en sık renkler piksellerin yüzde kaçını oluşturuyor?
  const cum = new Float64Array(order.length);
  let acc = 0;
  for (let i = 0; i < order.length; i++) {
    acc += runs.counts[order[i]];
    cum[i] = acc;
  }
  const colorsFor = (pct: number): number => {
    if (cum.length === 0) return 0;
    const target = (pct / 100) * vn;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo + 1;
  };
  const curve: { colors: number; pct: number }[] = [];
  if (cum.length > 0) {
    for (let c = 1; c <= cum.length; c *= 2) curve.push({ colors: c, pct: (cum[c - 1] / vn) * 100 });
    if (curve[curve.length - 1].colors !== cum.length) curve.push({ colors: cum.length, pct: 100 });
  }

  return {
    fileName: input.fileName,
    fileSize: input.fileSize,
    width,
    height,
    downscale: input.downscale,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    pixelCount: n,
    structure: input.structure,
    alpha: {
      opaque,
      transparent,
      partial,
      faint,
      allOpaque: opaque === n,
      histogram,
    },
    hiddenRgb,
    colors: {
      uniqueRgba,
      uniqueVisibleRgb,
      grayscale: vn > 0 && grayscale,
      top,
      coverage90: colorsFor(90),
      coverage95: colorsFor(95),
      coverage99: colorsFor(99),
      curve,
    },
    analysisMs: performance.now() - started,
  };
}
