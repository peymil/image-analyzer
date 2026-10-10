// Yükleme öncesi küçültme (kutu filtresi). Alfa ile ağırlıklı ortalama alınır:
// önce piksel × alfa toplanır, sonra alfaya bölünür. Böylece saydam pikseller
// renk değerlerini bozmaz (kenarlarda koyulaşma/aydınlanma olmaz).

export interface Downscaled {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** factor kadar küçültür: yeni boyut = round(boyut / factor), en az 1 piksel. */
export function boxDownscale(rgba: Uint8Array, width: number, height: number, factor: number): Downscaled {
  const dw = Math.max(1, Math.round(width / factor));
  const dh = Math.max(1, Math.round(height / factor));
  const out = new Uint8Array(dw * dh * 4);

  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * height) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * height) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor((dx * width) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * width) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 4;
          const alpha = rgba[p + 3];
          r += rgba[p] * alpha;
          g += rgba[p + 1] * alpha;
          b += rgba[p + 2] * alpha;
          a += alpha;
          count++;
        }
      }
      const q = (dy * dw + dx) * 4;
      if (a > 0) {
        out[q] = Math.round(r / a);
        out[q + 1] = Math.round(g / a);
        out[q + 2] = Math.round(b / a);
      }
      out[q + 3] = Math.round(a / count);
    }
  }
  return { width: dw, height: dh, rgba: out };
}
