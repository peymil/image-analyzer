import type { ImageAnalysis } from './pipeline/analyze';
import type { QualityStat } from './pipeline/variants';

export type VariantId = 'lossless' | 'faint0' | 'faintPalette256' | 'palette256' | 'palette128' | 'palette64';

export interface VariantResult {
  id: VariantId;
  /** kayipsiz: piksel değişmez. kayipli: renk paleti uygulanır. */
  kind: 'kayipsiz' | 'kayipli';
  sizeBytes: number;
  timeMs: number;
  paletteColors?: number;
  quality?: QualityStat;
  bytes: ArrayBuffer;
}

export interface WorkerRequest {
  type: 'run';
  fileName: string;
  fileSize: number;
  buffer: ArrayBuffer;
  /** Yükleme öncesi küçültme katsayısı: 1 (yok), 2, 3 veya 4. */
  scale: number;
}

/** Arayüz metinleri çeviri anahtarı + parametre olarak gönderilir (worker çeviri yapmaz). */
export type MessageKey = { key: string; params?: Record<string, string | number> };

export type WorkerMessage =
  | ({ type: 'progress'; pct: number } & MessageKey)
  | { type: 'analysis'; analysis: ImageAnalysis }
  /** Küçültülmüş kaynak görüntü (scale > 1 iken önizleme "Orijinal" tarafı için). */
  | { type: 'source'; bytes: ArrayBuffer }
  | { type: 'variant'; variant: VariantResult }
  | { type: 'done'; totalMs: number }
  | ({ type: 'error' } & MessageKey);
