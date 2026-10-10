// Optimizasyon varyantları ve kalite ölçümü.
import { encodePng } from './png-encode';
import { quantizeImage } from './wasm';

export interface QualityStat {
  /** Ön-çarpımlı (premultiplied) RGBA üzerinde PSNR, dB. Kayıpsız ise Infinity. */
  psnr: number;
  /** Görünür piksellerde (alfa ≥ 128) en büyük kanal farkı (0–255). */
  maxDiff: number;
  /** Görünür piksellerin yüzde kaçında kanal farkı 8'i aşıyor. */
  diffPct: number;
}

/**
 * Kayıpsız varyant: piksel değerleri bit-bit aynı kalır. Tüm alfa=255 ise alfa
 * kanalı atılır (RGB), değilse RGBA olarak yazılır. Saydam piksellerin gizli RGB
 * değerleri de korunur (silinirse tarayıcıda ölçeklemede renk farkı oluşur).
 * Metadata (pHYs vb.) yazılmaz.
 */
export async function encodeLossless(
  rgba: Uint8Array,
  width: number,
  height: number,
  allOpaque: boolean,
): Promise<Uint8Array> {
  const n = width * height;
  if (allOpaque) {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) {
      rgb[q] = rgba[p];
      rgb[q + 1] = rgba[p + 1];
      rgb[q + 2] = rgba[p + 2];
    }
    return encodePng({ width, height, colorType: 2, pixels: rgb });
  }
  return encodePng({ width, height, colorType: 6, pixels: rgba });
}

/** Alfası 0 < a ≤ maxAlpha olan pikselleri tamamen sıfırlar (RGB + alfa). */
export function zeroFaintAlpha(rgba: Uint8Array, maxAlpha: number): Uint8Array {
  const out = new Uint8Array(rgba);
  for (let p = 0; p < out.length; p += 4) {
    const a = out[p + 3];
    if (a <= maxAlpha) {
      out[p] = 0;
      out[p + 1] = 0;
      out[p + 2] = 0;
      out[p + 3] = 0;
    }
  }
  return out;
}

/** Soluk alfa varyantı: RGBA olarak yazılır. recon kalite ölçümü içindir. */
export async function encodeFaintZeroed(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxAlpha: number,
): Promise<{ png: Uint8Array; recon: Uint8Array }> {
  const recon = zeroFaintAlpha(rgba, maxAlpha);
  const png = await encodePng({ width, height, colorType: 6, pixels: recon });
  return { png, recon };
}

export interface PaletteResult {
  png: Uint8Array;
  /** Palet uygulandıktan sonra oluşan RGBA görüntü (kalite ölçümü için). */
  recon: Uint8Array;
  paletteColors: number;
}

/** libimagequant ile indeksli (colorType 3) PNG üretir. Alfa palet girişlerine tRNS olarak yazılır. */
export async function encodePalette(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxColors: number,
): Promise<PaletteResult> {
  const q = quantizeImage(rgba, width, height, maxColors);
  const paletteColors = Math.min(256, Math.floor(q.palette.length / 4));

  const plte = new Uint8Array(paletteColors * 3);
  const alphas = new Uint8Array(paletteColors);
  for (let i = 0; i < paletteColors; i++) {
    plte[i * 3] = q.palette[i * 4];
    plte[i * 3 + 1] = q.palette[i * 4 + 1];
    plte[i * 3 + 2] = q.palette[i * 4 + 2];
    alphas[i] = q.palette[i * 4 + 3];
  }
  // tRNS sondaki 255'leri gereksiz; kırp.
  let last = paletteColors - 1;
  while (last >= 0 && alphas[last] === 255) last--;
  const trns = last >= 0 ? alphas.subarray(0, last + 1) : undefined;

  const n = width * height;
  const recon = new Uint8Array(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const idx = q.indices[i];
    recon[p] = q.palette[idx * 4];
    recon[p + 1] = q.palette[idx * 4 + 1];
    recon[p + 2] = q.palette[idx * 4 + 2];
    recon[p + 3] = q.palette[idx * 4 + 3];
  }

  const png = await encodePng({
    width,
    height,
    colorType: 3,
    pixels: q.indices,
    palette: plte,
    transparency: trns ? new Uint8Array(trns) : undefined,
  });
  return { png, recon, paletteColors };
}

/** Orijinal ve sonuç RGBA arasındaki kalite (ön-çarpımlı PSNR ve görünür fark). */
export function measureQuality(orig: Uint8Array, recon: Uint8Array): QualityStat {
  const n = orig.length / 4;
  let se = 0;
  let maxDiff = 0;
  let visible = 0;
  let bigDiff = 0;
  for (let p = 0; p < orig.length; p += 4) {
    const a1 = orig[p + 3];
    const a2 = recon[p + 3];
    const s1 = a1 / 255;
    const s2 = a2 / 255;
    const dr = orig[p] * s1 - recon[p] * s2;
    const dg = orig[p + 1] * s1 - recon[p + 1] * s2;
    const db = orig[p + 2] * s1 - recon[p + 2] * s2;
    const da = a1 - a2;
    se += dr * dr + dg * dg + db * db + da * da;
    if (a1 >= 128 && a2 >= 128) {
      visible++;
      const m = Math.max(
        Math.abs(orig[p] - recon[p]),
        Math.abs(orig[p + 1] - recon[p + 1]),
        Math.abs(orig[p + 2] - recon[p + 2]),
      );
      if (m > maxDiff) maxDiff = m;
      if (m > 8) bigDiff++;
    }
  }
  const mse = se / (n * 4);
  return {
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    maxDiff,
    diffPct: visible > 0 ? (bigDiff / visible) * 100 : 0,
  };
}

export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
