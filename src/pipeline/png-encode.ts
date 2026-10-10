// Minimal PNG yazıcı (8-bit). Sıkıştırma tarayıcının yerleşik CompressionStream('deflate') ile yapılır;
// ardından oxipng ile optimize edilir.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngEncodeInput {
  width: number;
  height: number;
  colorType: PngColorType;
  /** Satır filtresi olmadan, sıkı paketlenmiş piksel verisi (indeksli ise indeks değerleri). */
  pixels: Uint8Array;
  /** Yalnızca colorType 3: RGB palet (3 bayt/giriş). */
  palette?: Uint8Array;
  /** Yalnızca colorType 3: palet girişlerinin alfa değerleri (tRNS). */
  transparency?: Uint8Array;
}

const CHANNELS: Record<PngColorType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function encodePng(input: PngEncodeInput): Promise<Uint8Array> {
  const { width, height, colorType, pixels } = input;
  const rowBytes = width * CHANNELS[colorType];
  if (pixels.length !== rowBytes * height) {
    throw new Error(`Piksel boyutu uyuşmuyor: ${pixels.length} != ${rowBytes * height}`);
  }

  // Her satırın başına filtre türü (0 = None) ekle.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
  }
  const idat = await zlibDeflate(raw);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit derinliği
  ihdr[9] = colorType;

  const parts: Uint8Array[] = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk('IHDR', ihdr),
  ];
  if (input.palette) parts.push(makeChunk('PLTE', input.palette));
  if (input.transparency && input.transparency.length > 0) parts.push(makeChunk('tRNS', input.transparency));
  parts.push(makeChunk('IDAT', idat), makeChunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
