// Çok dilli metinler. Metinler src/i18n/locales/*.json içinde; yeni dil için
// bir JSON dosyası ekleyip buradaki listeye kaydetmek yeterli.
import en from './locales/en.json';
import tr from './locales/tr.json';

export type Locale = 'tr' | 'en';
export type Params = Record<string, string | number>;

const dictionaries: Record<Locale, unknown> = { tr, en };
export const LOCALES: Locale[] = ['tr', 'en'];
const STORAGE_KEY = 'pngopt.locale';

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'tr' || saved === 'en') return saved;
  } catch {
    // localStorage kullanılamıyorsa tarayıcı diline bakılır.
  }
  return navigator.language?.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

let current: Locale = detectLocale();

export function getLocale(): Locale {
  return current;
}

/** Sayı biçimlendirme için BCP 47 yerel kodu. */
export function numberLocale(): string {
  return current === 'tr' ? 'tr-TR' : 'en-US';
}

function lookup(dict: unknown, key: string): unknown {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (node && typeof node === 'object' && part in node) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

/** Düz metin çevirisi. {ad} yer tutucuları params ile doldurulur. Bulunamazsa İngilizce, o da yoksa anahtar döner. */
export function t(key: string, params?: Params): string {
  const raw = lookup(dictionaries[current], key) ?? lookup(dictionaries.en, key);
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    params && name in params ? String(params[name]) : match,
  );
}

/** JSON içinde nesne/dizi olarak tutulan çeviriler (ör. açıklama blokları). */
export function tRaw<T>(key: string): T | undefined {
  return (lookup(dictionaries[current], key) ?? lookup(dictionaries.en, key)) as T | undefined;
}

/** data-i18n="anahtar" (metin), data-i18n-html="anahtar" (HTML), data-i18n-placeholder, data-i18n-title öznitelikleri. */
export function applyStaticTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml!);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.dataset.i18nTitle!));
  });
  document.documentElement.lang = current;
  document.title = t('app.title');
}

export function setLocale(locale: Locale): void {
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Kayıt başarısız olabilir; dil yine de değişir.
  }
  applyStaticTranslations();
}
