// WebAssembly modüllerinin tek giriş noktası.
// - @jsquash/png   : PNG çözme (squoosh, WASM)
// - @jsquash/oxipng: kayıpsız PNG optimizasyonu (oxipng, WASM)
// - imagequant.wasm: libimagequant (imagequant 4.4.1 crate) kendi derlemimiz, tek iş parçacıklı.
//                    Kaynak: wasm/imagequant/ ; yeniden derleme: wasm/imagequant/build.sh
import pngWasmUrl from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url';
import oxipngWasmUrl from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm?url';
import imagequantWasmUrl from './imagequant.wasm?url';
import { decode, init as initPngCodec } from '@jsquash/png/decode.js';
import oxipngOptimise, { init as initOxipng } from '@jsquash/oxipng/optimise.js';

let ready: Promise<unknown> | null = null;

/** Tüm WASM modüllerini bir kez yükler. */
export function initWasm(): Promise<unknown> {
  if (!ready) {
    ready = Promise.all([initPngCodec(pngWasmUrl), initOxipng(oxipngWasmUrl), initImageQuant()]);
  }
  return ready;
}

/** PNG'yi RGBA ImageData olarak çözer. */
export function decodePng(data: ArrayBuffer): Promise<ImageData> {
  return decode(data);
}

/** oxipng ile kayıpsız optimizasyon (level 0–6). */
export function optimizePngLossless(data: ArrayBuffer, level = 2): Promise<ArrayBuffer> {
  return oxipngOptimise(data, { level });
}

// ---------- libimagequant (kendi WASM sarmalayıcımız, src/... wasm/imagequant/src/lib.rs) ----------

interface ImageQuantExports {
  memory: WebAssembly.Memory;
  iq_alloc(len: number): number;
  iq_free(ptr: number, len: number): void;
  iq_quantize(
    rgbaPtr: number,
    width: number,
    height: number,
    maxColors: number,
    speed: number,
    minQuality: number,
    targetQuality: number,
  ): number;
  iq_palette_ptr(): number;
  iq_palette_len(): number;
  iq_indices_ptr(): number;
  iq_indices_len(): number;
  iq_quality(): number;
  iq_release(): void;
}

let iq: ImageQuantExports | null = null;

async function initImageQuant(): Promise<void> {
  if (iq) return;
  const bytes = await (await fetch(imagequantWasmUrl)).arrayBuffer();
  // Kaynak derlemede hiç import yok: thread, env veya wasm-bindgen gerekmez.
  const { instance } = await WebAssembly.instantiate(bytes, {});
  iq = instance.exports as unknown as ImageQuantExports;
}

export interface QuantizeOutput {
  /** RGBA palet: her giriş 4 bayt (R,G,B,A). */
  palette: Uint8Array;
  /** Her piksel için palet indeksi (genişlik × yükseklik bayt). */
  indices: Uint8Array;
  /** libimagequant kalite tahmini 0–100; -1 ise yok. */
  quality: number;
}

/**
 * libimagequant ile en fazla maxColors renkli palet üretir. Girdi RGBA (width*height*4 bayt).
 * Kalite tabanı 0, hedef 100: libimagequant en iyi çabayı yapar, reddetmez.
 */
export function quantizeImage(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxColors: number,
  speed = 4,
): QuantizeOutput {
  if (!iq) throw new Error('imagequant WASM henüz yüklenmedi (initWasm çağrılmalı)');
  const x = iq;
  const inPtr = x.iq_alloc(rgba.length);
  // Bellek büyüyebildiği için her yazımdan sonra görünümü yeniden al.
  new Uint8Array(x.memory.buffer, inPtr, rgba.length).set(rgba);
  let rc: number;
  try {
    rc = x.iq_quantize(inPtr, width, height, maxColors, speed, 0, 100);
  } finally {
    x.iq_free(inPtr, rgba.length);
  }
  if (rc !== 0) {
    x.iq_release();
    throw new Error(`imagequant hatası (kod ${rc}, maxColors=${maxColors})`);
  }
  const paletteLen = x.iq_palette_len();
  const indicesLen = x.iq_indices_len();
  // Kopyala: iq_release sonrası kaynak bellek geçersiz olur.
  const palette = new Uint8Array(x.memory.buffer, x.iq_palette_ptr(), paletteLen).slice();
  const indices = new Uint8Array(x.memory.buffer, x.iq_indices_ptr(), indicesLen).slice();
  const quality = x.iq_quality();
  x.iq_release();
  return { palette, indices, quality };
}
