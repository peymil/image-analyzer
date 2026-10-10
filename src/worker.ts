// Ağır işlemler (çözme, analiz, WASM sıkıştırma) bu Web Worker içinde çalışır; arayüz donmaz.
import { decodePng, initWasm, optimizePngLossless } from './pipeline/wasm';
import { parsePngStructure, PngFormatError } from './pipeline/png-parse';
import { analyzeImage, FAINT_MAX_ALPHA } from './pipeline/analyze';
import { encodeFaintZeroed, encodeLossless, encodePalette, measureQuality, toArrayBuffer } from './pipeline/variants';
import { encodePng } from './pipeline/png-encode';
import { boxDownscale } from './pipeline/resize';
import type { VariantId, VariantResult, WorkerMessage, WorkerRequest } from './types';

// DOM tipleri olmadan worker bağlamı için minimal tanım.
const ctx = self as unknown as {
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

const send = (msg: WorkerMessage, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
const progress = (pct: number, key: string, params?: Record<string, string | number>) =>
  send({ type: 'progress', pct, key, params });

function emitVariant(variant: VariantResult): void {
  send({ type: 'variant', variant }, [variant.bytes]);
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  try {
    const { fileName, fileSize, buffer, scale } = ev.data;
    const bytes = new Uint8Array(buffer);

    progress(3, 'progress.readStructure');
    const structure = parsePngStructure(bytes);

    progress(8, 'progress.loadWasm');
    await initWasm();

    progress(15, 'progress.decode');
    const img = await decodePng(buffer.slice(0));
    const sourceWidth = img.width;
    const sourceHeight = img.height;
    let rgba: Uint8Array = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    let width = sourceWidth;
    let height = sourceHeight;

    // Yükleme öncesi küçültme: tüm analiz ve varyantlar küçültülmüş görüntü üzerinde çalışır.
    const factor = Math.max(1, Math.round(scale));
    if (factor > 1) {
      progress(18, 'progress.downscale', { factor });
      const small = boxDownscale(rgba, sourceWidth, sourceHeight, factor);
      width = small.width;
      height = small.height;
      rgba = small.rgba;
      // Önizlemenin "Orijinal" tarafı küçültülmüş kaynak olsun (aynı boyutta karşılaştırma için).
      const sourcePng = await encodePng({ width, height, colorType: 6, pixels: rgba });
      const sourceBytes = toArrayBuffer(sourcePng);
      send({ type: 'source', bytes: sourceBytes }, [sourceBytes]);
    }

    progress(25, 'progress.analyze');
    const analysis = analyzeImage({
      fileName,
      fileSize,
      structure,
      rgba,
      width,
      height,
      downscale: factor,
      sourceWidth,
      sourceHeight,
    });
    send({ type: 'analysis', analysis });

    // 1) Kayıpsız: alfa temizliği / alfa kaldırma + oxipng
    progress(35, 'progress.lossless');
    let t = performance.now();
    const losslessRaw = await encodeLossless(rgba, width, height, analysis.alpha.allOpaque);
    const losslessOut = await optimizePngLossless(toArrayBuffer(losslessRaw), 2);
    emitVariant({
      id: 'lossless',
      kind: 'kayipsiz',
      sizeBytes: losslessOut.byteLength,
      timeMs: performance.now() - t,
      bytes: losslessOut,
    });

    // 1b) Soluk alfa (1–3) → 0: kayıplı ama görsel olarak neredeyse fark etmez
    if (analysis.alpha.faint > 0) {
      progress(38, 'progress.faint');
      t = performance.now();
      const faint = await encodeFaintZeroed(rgba, width, height, FAINT_MAX_ALPHA);
      const faintOut = await optimizePngLossless(toArrayBuffer(faint.png), 2);
      emitVariant({
        id: 'faint0',
        kind: 'kayipli',
        sizeBytes: faintOut.byteLength,
        timeMs: performance.now() - t,
        quality: measureQuality(rgba, faint.recon),
        bytes: faintOut,
      });

      // 1c) Soluk alfa → 0 + 256 renk palet + oxipng (seviye 2)
      progress(44, 'progress.palette', { n: 256 });
      t = performance.now();
      const combo = await encodePalette(faint.recon, width, height, 256);
      const comboOut = await optimizePngLossless(toArrayBuffer(combo.png), 2);
      emitVariant({
        id: 'faintPalette256',
        kind: 'kayipli',
        sizeBytes: comboOut.byteLength,
        timeMs: performance.now() - t,
        paletteColors: combo.paletteColors,
        quality: measureQuality(rgba, combo.recon),
        bytes: comboOut,
      });
    }

    // 2) Kayıplı palet: 256, 128, 64 renk
    const paletteSteps: { max: 256 | 128 | 64; from: number; to: number }[] = [
      { max: 256, from: 50, to: 66 },
      { max: 128, from: 66, to: 82 },
      { max: 64, from: 82, to: 96 },
    ];
    for (const step of paletteSteps) {
      progress(step.from, 'progress.palette', { n: step.max });
      t = performance.now();
      const pal = await encodePalette(rgba, width, height, step.max);
      const out = await optimizePngLossless(toArrayBuffer(pal.png), 2);
      const quality = measureQuality(rgba, pal.recon);
      emitVariant({
        id: `palette${step.max}` as VariantId,
        kind: 'kayipli',
        sizeBytes: out.byteLength,
        timeMs: performance.now() - t,
        paletteColors: pal.paletteColors,
        quality,
        bytes: out,
      });
      progress(step.to, 'progress.paletteDone', { n: step.max });
    }

    send({ type: 'done', totalMs: performance.now() - started });
  } catch (err) {
    if (err instanceof PngFormatError) {
      send({ type: 'error', key: `errors.${err.code}` });
    } else {
      send({ type: 'error', key: 'errors.analysisFailed', params: { message: err instanceof Error ? err.message : String(err) } });
    }
  }
};

