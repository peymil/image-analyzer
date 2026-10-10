import { Chart, registerables, type ChartConfiguration, type ChartType } from 'chart.js';
import type { ImageAnalysis } from './pipeline/analyze';
import { FAINT_MAX_ALPHA } from './pipeline/analyze';
import { buildRecommendations, colorTypeKey, UNITY_MAX_SIZE, type Recommendation } from './recommendations';
import { escapeHtml, fmtKB, fmtMB, fmtNum, fmtPct, fmtSec, fmtFixed, psnrVerdictKey } from './format';
import {
  applyStaticTranslations,
  getLocale,
  setLocale,
  t,
  tRaw,
  type Locale,
  type Params,
} from './i18n';
import type { VariantId, VariantResult, WorkerMessage, WorkerRequest } from './types';

Chart.register(...registerables);

const VARIANT_ORDER: VariantId[] = ['lossless', 'faint0', 'faintPalette256', 'palette256', 'palette128', 'palette64'];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Eleman bulunamadı: #${id}`);
  return el as T;
};

const charts = new Map<string, Chart>();
const blobUrls: string[] = [];
const urlCache = new Map<VariantId, string>();
let currentAnalysis: ImageAnalysis | null = null;
let currentVariants: VariantResult[] = [];
let originalUrl = '';
let currentWorker: Worker | null = null;
let lastStatus: { pct: number; key: string; params?: Params } | null = null;
let lastError: { key: string; params?: Params } | null = null;

type ChartConfig = ChartConfiguration<ChartType, number[] | (number | null)[], unknown>;

function setChart(key: string, canvasId: string, config: ChartConfig): void {
  charts.get(key)?.destroy();
  charts.set(key, new Chart($<HTMLCanvasElement>(canvasId), config));
}

function resetAll(): void {
  for (const c of charts.values()) c.destroy();
  charts.clear();
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls.length = 0;
  urlCache.clear();
  currentAnalysis = null;
  currentVariants = [];
  lastError = null;
  $('error').hidden = true;
  $('results').hidden = true;
  for (const id of ['summary', 'info', 'alpha-text', 'colors-text', 'variants-table', 'recs', 'unity']) {
    $(id).innerHTML = '';
  }
}

function setStatus(pct: number, key: string, params?: Params): void {
  lastStatus = { pct, key, params };
  $('status').hidden = false;
  $('bar-fill').style.width = `${Math.round(pct)}%`;
  $('status-text').textContent = t(key, params);
}

function showError(key: string, params?: Params): void {
  lastError = { key, params };
  $('status').hidden = true;
  const el = $('error');
  el.hidden = false;
  el.textContent = t(key, params);
}

function bytesToUrlCached(v: VariantResult): string {
  let url = urlCache.get(v.id);
  if (!url) {
    url = URL.createObjectURL(new Blob([v.bytes], { type: 'image/png' }));
    urlCache.set(v.id, url);
    blobUrls.push(url);
  }
  return url;
}

function downloadName(variantId: VariantId): string {
  const base = currentAnalysis ? currentAnalysis.fileName.replace(/\.png$/i, '') : 'image';
  return `${base}-${variantId}.png`;
}

function variantLabel(v: VariantResult): string {
  if (v.id === 'lossless') return t('variant.lossless');
  if (v.id === 'faint0') return t('variant.faint0');
  if (v.id === 'faintPalette256') return t('variant.faintPalette256');
  return t('variant.palette', { n: Number(v.id.replace('palette', '')) });
}

function colorTypeLabel(colorType: number): string {
  return t(colorTypeKey(colorType), { type: colorType });
}

// ---------- Bölümler ----------

function renderInfo(a: ImageAnalysis): void {
  const s = a.structure;
  const chunkList = [...new Set(s.chunks.map((c) => c.type))].join(', ');
  $('info').innerHTML = `
    <h2>${t('sections.info')}</h2>
    <dl class="facts">
      <dt>${t('info.file')}</dt><dd>${escapeHtml(a.fileName)}</dd>
      <dt>${t('info.fileSize')}</dt><dd>${t('info.fileSizeValue', { size: fmtMB(a.fileSize), bytes: fmtNum(a.fileSize) })}</dd>
      <dt>${t('info.dimensions')}</dt><dd>${t('info.dimensionsValue', { w: fmtNum(a.width), h: fmtNum(a.height), pixels: fmtNum(a.pixelCount) })}</dd>
      ${a.downscale > 1 ? `<dt>${t('info.downscale')}</dt><dd>${t('info.downscaleValue', { factor: a.downscale, sw: fmtNum(a.sourceWidth), sh: fmtNum(a.sourceHeight), w: fmtNum(a.width), h: fmtNum(a.height) })}</dd>` : ''}
      <dt>${t('info.colorType')}</dt><dd>${t('info.colorTypeValue', { type: colorTypeLabel(s.colorType), bits: s.bitDepth })}</dd>
      <dt>${t('info.bytesPerPixel')}</dt><dd>${t('info.bytesPerPixelValue', { bpp: fmtFixed(a.fileSize / a.pixelCount, 2) })}</dd>
      <dt>${t('info.interlace')}</dt><dd>${s.interlaced ? t('info.interlaceYes') : t('info.no')}</dd>
      <dt>${t('info.dpi')}</dt><dd>${s.dpi ? t('info.dpiValue', { dpi: s.dpi }) : t('info.dpiNone')}</dd>
      <dt>${t('info.idat')}</dt><dd>${s.idatCount}</dd>
      <dt>${t('info.chunks')}</dt><dd>${escapeHtml(chunkList)}</dd>
      <dt>${t('info.analysisTime')}</dt><dd>${t('info.analysisTimeValue', { ms: fmtFixed(a.analysisMs, 0) + ' ms' })}</dd>
    </dl>`;
}

function renderAlpha(a: ImageAnalysis): void {
  const n = a.pixelCount;
  const { opaque, transparent, partial, faint } = a.alpha;
  const hiddenPct = transparent > 0 ? (a.hiddenRgb / transparent) * 100 : 0;
  const pieLabels = [t('alpha.pieOpaque'), t('alpha.pieTransparent'), t('alpha.piePartial')];
  $('alpha-text').innerHTML = `
    <dl class="facts">
      <dt>${t('alpha.opaque')}</dt><dd>${fmtPct((opaque / n) * 100)}</dd>
      <dt>${t('alpha.transparent')}</dt><dd>${fmtPct((transparent / n) * 100)}</dd>
      <dt>${t('alpha.partial')}</dt><dd>${fmtPct((partial / n) * 100)}</dd>
      <dt>${t('alpha.faint', { max: FAINT_MAX_ALPHA })}</dt><dd>${fmtPct((faint / n) * 100)}</dd>
      <dt>${t('alpha.hiddenRgb')}</dt><dd>${t('alpha.hiddenRgbValue', { pct: fmtPct(hiddenPct), count: fmtNum(a.hiddenRgb) })}</dd>
      <dt>${t('alpha.status')}</dt><dd>${a.alpha.allOpaque ? t('alpha.statusUnused') : t('alpha.statusUsed')}</dd>
    </dl>`;

  setChart('alphaPie', 'chart-alpha-pie', {
    type: 'doughnut',
    data: {
      labels: pieLabels,
      datasets: [{ data: [opaque, transparent, partial], backgroundColor: ['#334155', '#cbd5e1', '#f59e0b'] }],
    },
    options: {
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              t('alpha.tooltip', { label: String(ctx.label), pct: fmtPct((Number(ctx.raw) / n) * 100) }),
          },
        },
      },
    },
  });

  const labels = Array.from({ length: 256 }, (_, i) => String(i));
  setChart('alphaHist', 'chart-alpha-hist', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('alpha.histCount'),
          data: a.alpha.histogram,
          backgroundColor: labels.map((_, i) => (i === 0 ? '#94a3b8' : i === 255 ? '#334155' : '#f59e0b')),
        },
      ],
    },
    options: {
      scales: {
        x: { title: { display: true, text: t('alpha.histX') }, ticks: { maxTicksLimit: 17 } },
        y: { type: 'logarithmic', title: { display: true, text: t('alpha.histY') } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

function renderColors(a: ImageAnalysis): void {
  const c = a.colors;
  const n = a.pixelCount;
  const over256 = c.uniqueVisibleRgb > 256;
  $('colors-text').innerHTML = `
    <dl class="facts">
      <dt>${t('colors.uniqueRgba')}</dt><dd>${fmtNum(c.uniqueRgba)}</dd>
      <dt>${t('colors.uniqueVisible')}</dt><dd>${over256 ? t('colors.uniqueVisibleOver', { count: fmtNum(c.uniqueVisibleRgb) }) : t('colors.uniqueVisibleUnder', { count: fmtNum(c.uniqueVisibleRgb) })}</dd>
      <dt>${t('colors.coverage')}</dt><dd>${t('colors.coverageValue', { c90: fmtNum(c.coverage90), c95: fmtNum(c.coverage95), c99: fmtNum(c.coverage99) })}</dd>
      <dt>${t('colors.grayscale')}</dt><dd>${c.grayscale ? t('colors.grayscaleYes') : t('colors.grayscaleNo')}</dd>
      <dt>${t('colors.visibleShare')}</dt><dd>${fmtPct(((n - a.alpha.transparent) / n) * 100)}</dd>
    </dl>`;

  setChart('topColors', 'chart-top-colors', {
    type: 'bar',
    data: {
      labels: c.top.map((x) => x.hex),
      datasets: [
        {
          label: t('colors.pixelsLabel'),
          data: c.top.map((x) => x.count),
          backgroundColor: c.top.map((x) => x.hex),
          borderColor: '#64748b',
          borderWidth: 1,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: t('colors.topX') } } },
    },
  });

  setChart('coverage', 'chart-coverage', {
    type: 'line',
    data: {
      labels: c.curve.map((p) => fmtNum(p.colors)),
      datasets: [
        {
          label: t('colors.coverageDataset'),
          data: c.curve.map((p) => Number(p.pct.toFixed(2))),
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.15)',
          fill: true,
          tension: 0.25,
        },
      ],
    },
    options: {
      scales: {
        x: { title: { display: true, text: t('colors.coverageX') } },
        y: { min: 0, max: 100, title: { display: true, text: t('colors.coverageY') } },
      },
    },
  });
}

function variantRow(v: VariantResult, orig: number): string {
  const saving = ((orig - v.sizeBytes) / orig) * 100;
  const q = v.quality;
  const quality = q
    ? t('table.psnrLine', {
        psnr: Number.isFinite(q.psnr) ? fmtFixed(q.psnr, 1) : t('table.infinite'),
        maxDiff: q.maxDiff,
        pct: fmtPct(q.diffPct),
      })
    : t('table.noDiff');
  const kindClass = v.kind === 'kayipsiz' ? 'lossless' : 'lossy';
  return `<tr>
    <td>${escapeHtml(variantLabel(v))}<br/><span class="badge risk-${kindClass}">${t(v.kind === 'kayipsiz' ? 'kind.lossless' : 'kind.lossy')}</span></td>
    <td class="num">${fmtMB(v.sizeBytes)}</td>
    <td class="num">${saving >= 0 ? '−' : '+'}${Math.abs(saving).toFixed(1)}%</td>
    <td class="num">${v.paletteColors ?? '—'}</td>
    <td class="num">${fmtSec(v.timeMs)}</td>
    <td>${escapeHtml(quality)}${q ? `<br/><span class="score-note">${t(psnrVerdictKey(q.psnr))}</span>` : ''}</td>
    <td><a class="dl" href="${bytesToUrlCached(v)}" download="${escapeHtml(downloadName(v.id))}">${t('table.download')}</a></td>
  </tr>`;
}

function renderCompression(a: ImageAnalysis, variants: VariantResult[]): void {
  const orig = a.fileSize;
  const labels = [t('compression.original'), ...variants.map(variantLabel)];
  const data = [orig, ...variants.map((v) => v.sizeBytes)].map((b) => Number((b / (1024 * 1024)).toFixed(3)));
  setChart('size', 'chart-size', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('compression.sizeLabel'),
          data,
          backgroundColor: ['#64748b', '#16a34a', '#0ea5e9', '#14b8a6', '#7c3aed', '#8b5cf6', '#a78bfa'].slice(0, labels.length),
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: t('palette.mbAxis') } } },
    },
  });

  const rows = variants.map((v) => variantRow(v, orig)).join('');
  $('variants-table').innerHTML = `
    <table>
      <thead><tr>
        <th>${t('table.variant')}</th><th class="num">${t('table.size')}</th><th class="num">${t('table.saving')}</th>
        <th class="num">${t('table.colors')}</th><th class="num">${t('table.time')}</th><th>${t('table.quality')}</th><th>${t('table.file')}</th>
      </tr></thead>
      <tbody>
        <tr><td>${t('compression.original')}</td><td class="num">${fmtMB(orig)}</td><td class="num">—</td><td class="num">${a.colors.uniqueVisibleRgb > 0 ? fmtNum(a.colors.uniqueVisibleRgb) : '—'}</td><td class="num">—</td><td>${t('compression.reference')}</td><td></td></tr>
        ${rows}
      </tbody>
    </table>
    <p class="score-note">${t('compression.note')}</p>`;

  const palettes = variants.filter((v) => v.quality && v.paletteColors !== undefined);
  setChart('quality', 'chart-quality', {
    type: 'bar',
    data: {
      labels: palettes.map((v) => t('palette.chartLabel', { n: v.paletteColors ?? '' })),
      datasets: [
        {
          type: 'bar',
          label: t('palette.sizeDataset'),
          data: palettes.map((v) => Number((v.sizeBytes / (1024 * 1024)).toFixed(3))),
          backgroundColor: '#8b5cf6',
          yAxisID: 'y',
        },
        {
          type: 'line',
          label: t('palette.psnrDataset'),
          data: palettes.map((v) => Number((v.quality?.psnr ?? 0).toFixed(2))),
          borderColor: '#15803d',
          backgroundColor: '#15803d',
          yAxisID: 'y1',
          tension: 0.2,
        },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true, position: 'left', title: { display: true, text: t('palette.mbAxis') } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: t('palette.psnrAxis') } },
      },
    },
  });
}

function renderSummary(a: ImageAnalysis, variants: VariantResult[], recs: Recommendation[], score: number): void {
  const top = recs.filter((r) => r.severity === 'high' || r.severity === 'medium').slice(0, 3);
  const best = variants.find((v) => v.id === 'lossless');
  const saving = best ? a.fileSize - best.sizeBytes : 0;
  $('summary').innerHTML = `
    <h2>${t('sections.summary')}</h2>
    <div class="score">
      <div class="score-value">${score}</div>
      <div>
        <strong>${t('summary.score')}</strong> (${t('summary.scoreNote')})
        <div class="score-note">${t('summary.file', { name: escapeHtml(a.fileName), size: fmtMB(a.fileSize), w: fmtNum(a.width), h: fmtNum(a.height) })}</div>
        ${best ? `<div class="score-note">${t('summary.saving', { size: fmtMB(best.sizeBytes), saving: fmtMB(saving), pct: fmtPct((saving / a.fileSize) * 100) })}</div>` : ''}
      </div>
    </div>
    ${top.length ? `<h3>${t('summary.topIssues')}</h3><ul class="recs">${top.map((r) => `<li><span class="badge ${r.severity}">${severityLabel(r.severity)}</span>${escapeHtml(recTitle(r))}</li>`).join('')}</ul>` : ''}`;
}

function recTitle(r: Recommendation): string {
  return t(r.titleKey, r.titleParams);
}

function renderRecs(recs: Recommendation[]): void {
  $('recs').innerHTML = `
    <h2>${t('sections.recs')}</h2>
    ${
      recs.length === 0
        ? `<p>${t('recs.none')}</p>`
        : `<ul class="recs">${recs
            .map(
              (r) => `<li>
                <span class="badge ${r.severity}">${severityLabel(r.severity)}</span>
                <span class="badge risk-${r.risk}">${t('risk.' + r.risk)}</span>
                <strong>${escapeHtml(recTitle(r))}</strong>
                ${r.savingBytes !== undefined ? `<span class="score-note"> ${t('recs.saving', { size: fmtMB(r.savingBytes) })}</span>` : ''}
                <p class="detail">${escapeHtml(t(r.detailKey, r.detailParams))}</p>
              </li>`,
            )
            .join('')}</ul>`
    }`;
}

function renderUnity(a: ImageAnalysis): void {
  const maxSide = Math.max(a.width, a.height);
  const exceeded = maxSide > UNITY_MAX_SIZE;
  $('unity').innerHTML = `
    <h2>${t('sections.unity')}</h2>
    <dl class="facts">
      <dt>${t('unity.size')}</dt><dd>${t('unity.sizeValue', { w: a.width, h: a.height, max: maxSide })}</dd>
      <dt>${t('unity.maxSize')}</dt><dd>${t('unity.maxSizeValue', { max: UNITY_MAX_SIZE, status: exceeded ? t('unity.exceeded') : t('unity.ok') })}</dd>
      <dt>${t('unity.fileSize')}</dt><dd>${fmtKB(a.fileSize)}</dd>
    </dl>
    <p>${t('unity.body')}</p>`;
}

function renderExplain(): void {
  type Block = { type: 'h2'; text: string } | { type: 'details'; summary: string; html: string; open?: boolean };
  const blocks = tRaw<Block[]>('explain.blocks') ?? [];
  const html = blocks
    .map((b) =>
      b.type === 'h2'
        ? `<h3 class="explain-h">${escapeHtml(b.text)}</h3>`
        : `<details${b.open ? ' open' : ''}><summary>${escapeHtml(b.summary)}</summary>${b.html}</details>`,
    )
    .join('');
  $('explain').innerHTML = `<h2>${t('sections.explain')}</h2><div class="explain">${html}</div>`;
}

let previewVariants: VariantResult[] = [];

/** Dropdown'da seçili varyantı sağ taraftaki sonuç görüntüsüne yazar. */
function showSelectedPreview(): void {
  const select = $<HTMLSelectElement>('preview-select');
  const v = previewVariants.find((x) => x.id === select.value) ?? previewVariants[0];
  if (!v) return;
  $<HTMLImageElement>('img-result').src = bytesToUrlCached(v);
  $('cap-result').textContent = t('preview.result', { label: variantLabel(v), size: fmtMB(v.sizeBytes) });
}

function renderPreviews(variants: VariantResult[]): void {
  previewVariants = variants;
  $<HTMLImageElement>('img-original').src = originalUrl;
  const select = $<HTMLSelectElement>('preview-select');
  // Seçenekler yalnızca varyant listesi değişince yeniden kurulur; kullanıcının seçimi korunur.
  const ids = variants.map((v) => v.id).join(',');
  if (select.dataset.ids !== ids) {
    const previous = select.value;
    select.innerHTML = variants.map((v) => `<option value="${v.id}">${escapeHtml(variantLabel(v))}</option>`).join('');
    select.dataset.ids = ids;
    if (previous && variants.some((v) => v.id === previous)) select.value = previous;
  }
  showSelectedPreview();
  applyComparePct();
}

// ---------- Karşılaştırma (sol: orijinal, sağ: seçilen sonuç; ortadaki çizgi sürüklenir) ----------

let comparePct = 50;

function applyComparePct(): void {
  $('compare-line').style.left = `${comparePct}%`;
  // İki görüntü üst üste binmesin: orijinal yalnızca sol, sonuç yalnızca sağ tarafta görünür.
  // (Aksi halde yarı saydam pikseller iki kez çizilir ve sağ taraf koyulaşır.)
  $<HTMLImageElement>('img-original').style.clipPath = `inset(0 ${100 - comparePct}% 0 0)`;
  $<HTMLImageElement>('img-result').style.clipPath = `inset(0 0 0 ${comparePct}%)`;
  $('compare').setAttribute('aria-valuenow', String(Math.round(comparePct)));
}

function setupCompare(): void {
  const box = $('compare');
  let dragging = false;
  const fromClientX = (clientX: number) => {
    const r = box.getBoundingClientRect();
    if (r.width === 0) return;
    comparePct = Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100));
    applyComparePct();
  };
  box.addEventListener('pointerdown', (e) => {
    dragging = true;
    box.setPointerCapture(e.pointerId);
    fromClientX(e.clientX);
  });
  box.addEventListener('pointermove', (e) => {
    if (dragging) fromClientX(e.clientX);
  });
  const stop = () => {
    dragging = false;
  };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') comparePct = Math.max(0, comparePct - 2);
    else if (e.key === 'ArrowRight') comparePct = Math.min(100, comparePct + 2);
    else return;
    e.preventDefault();
    applyComparePct();
  });
  applyComparePct();
}

function severityLabel(s: Recommendation['severity']): string {
  return t('severity.' + s);
}

function sortVariants(vs: VariantResult[]): VariantResult[] {
  return [...vs].sort((x, y) => VARIANT_ORDER.indexOf(x.id) - VARIANT_ORDER.indexOf(y.id));
}

function renderAll(): void {
  if (!currentAnalysis) return;
  const variants = sortVariants(currentVariants);
  const { items, score } = buildRecommendations(currentAnalysis, variants);
  renderSummary(currentAnalysis, variants, items, score);
  renderCompression(currentAnalysis, variants);
  renderRecs(items);
  renderPreviews(variants);
}

function onAnalysis(a: ImageAnalysis): void {
  currentAnalysis = a;
  $('results').hidden = false;
  renderInfo(a);
  renderAlpha(a);
  renderColors(a);
  renderUnity(a);
}

// ---------- Dosya işleme ----------

function handleFile(file: File): void {
  resetAll();
  const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
  if (!isPng) {
    showError('errors.notPng');
    return;
  }
  originalUrl = URL.createObjectURL(file);
  blobUrls.push(originalUrl);
  setStatus(0, 'progress.start');

  currentWorker?.terminate();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  currentWorker = worker;
  const started = performance.now();

  worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
    const msg = ev.data;
    switch (msg.type) {
      case 'progress':
        setStatus(msg.pct, msg.key, msg.params);
        break;
      case 'analysis':
        onAnalysis(msg.analysis);
        break;
      case 'source':
        // Küçültülmüş kaynak: "Orijinal" önizleme tarafı bunu gösterir.
        originalUrl = URL.createObjectURL(new Blob([msg.bytes], { type: 'image/png' }));
        blobUrls.push(originalUrl);
        break;
      case 'variant':
        currentVariants = [...currentVariants.filter((v) => v.id !== msg.variant.id), msg.variant];
        renderAll();
        break;
      case 'done':
        setStatus(100, 'progress.done', { time: fmtSec(msg.totalMs ?? performance.now() - started) });
        worker.terminate();
        currentWorker = null;
        break;
      case 'error':
        showError(msg.key, msg.params);
        worker.terminate();
        currentWorker = null;
        break;
    }
  };
  worker.onerror = (ev) => {
    showError('errors.workerError', { message: ev.message || 'Worker' });
    worker.terminate();
    currentWorker = null;
  };

  file.arrayBuffer().then((buffer) => {
    const scale = Number($<HTMLSelectElement>('downscale').value) || 1;
    const req: WorkerRequest = { type: 'run', fileName: file.name, fileSize: file.size, buffer, scale };
    worker.postMessage(req, [buffer]);
  });
}

// ---------- Dil değişimi ----------

function onLocaleChange(locale: Locale): void {
  setLocale(locale);
  $<HTMLSelectElement>('lang-select').value = locale;
  if (lastStatus) setStatus(lastStatus.pct, lastStatus.key, lastStatus.params);
  if (lastError) showError(lastError.key, lastError.params);
  renderExplain();
  if (currentAnalysis) {
    onAnalysis(currentAnalysis);
    renderAll();
  }
}

// ---------- Başlangıç ----------

const langSelect = $<HTMLSelectElement>('lang-select');
applyStaticTranslations();
langSelect.value = getLocale();
langSelect.addEventListener('change', () => onLocaleChange(langSelect.value as Locale));
renderExplain();
setupCompare();
$('preview-select').addEventListener('change', showSelectedPreview);
$<HTMLSelectElement>('preview-bg').addEventListener('change', (ev) => {
  $('compare').dataset.bg = (ev.target as HTMLSelectElement).value;
});
$('preview-select').addEventListener('input', showSelectedPreview);

const drop = $('dropzone');
const input = $<HTMLInputElement>('file');
drop.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const f = input.files?.[0];
  if (f) handleFile(f);
  input.value = '';
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});
