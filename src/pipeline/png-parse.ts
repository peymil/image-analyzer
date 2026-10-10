// PNG dosya yapısını (chunk listesi, IHDR, pHYs) okur. Piksel çözmez.

export interface PngChunkInfo {
  type: string;
  length: number;
}

export interface PngStructure {
  width: number;
  height: number;
  bitDepth: number;
  /** 0 gri, 2 RGB, 3 indexed, 4 gri+alfa, 6 RGBA */
  colorType: number;
  interlaced: boolean;
  chunks: PngChunkInfo[];
  idatCount: number;
  /** pHYs'ten hesaplanan DPI (yoksa null). */
  dpi: number | null;
  hasIcc: boolean;
  textChunkCount: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Dosya yapısı hataları; kod, arayüzde çeviri anahtarına eşlenir. */
export class PngFormatError extends Error {
  constructor(public readonly code: 'invalidPng' | 'noIhdr') {
    super(code);
  }
}

export function parsePngStructure(bytes: Uint8Array): PngStructure {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new PngFormatError('invalidPng');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunkInfo[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaced = false;
  let dpi: number | null = null;
  let idatCount = 0;
  let hasIcc = false;
  let textChunkCount = 0;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = offset + 8;
    chunks.push({ type, length });

    if (type === 'IHDR') {
      width = view.getUint32(data);
      height = view.getUint32(data + 4);
      bitDepth = bytes[data + 8];
      colorType = bytes[data + 9];
      interlaced = bytes[data + 12] === 1;
    } else if (type === 'pHYs') {
      const ppuX = view.getUint32(data);
      const unit = bytes[data + 8];
      if (unit === 1) dpi = Math.round(ppuX * 0.0254);
    } else if (type === 'IDAT') {
      idatCount++;
    } else if (type === 'iCCP') {
      hasIcc = true;
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      textChunkCount++;
    }

    offset = data + length + 4; // veri + CRC
    if (type === 'IEND') break;
  }

  if (width === 0 || height === 0) {
    throw new PngFormatError('noIhdr');
  }

  return { width, height, bitDepth, colorType, interlaced, chunks, idatCount, dpi, hasIcc, textChunkCount };
}
