import { createEffect, createRoot, createSignal } from 'solid-js';
import { readSharedPreference, writeSharedPreference } from './locale-preference';
import { translations } from './messages';

export type Locale = 'en' | 'pt' | 'es';
export type Preference = Locale | 'system';
const STORAGE_KEY = 'plunz.manga.locale';

export function detectLocale(tags: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages): Locale {
  const preferred = tags.length ? tags : typeof navigator === 'undefined' ? [] : [navigator.language];
  for (const tag of preferred) {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (base === 'en' || base === 'pt' || base === 'es') return base;
  }
  return 'en';
}

function readPreference(): Preference {
  try { return readSharedPreference(localStorage, STORAGE_KEY); }
  catch { return 'system'; }
}

const state = createRoot(() => {
  const [preference, setPreference] = createSignal<Preference>(readPreference());
  const [systemLocale, setSystemLocale] = createSignal<Locale>(detectLocale());
  const locale = (): Locale => (preference() === 'system' ? systemLocale() : (preference() as Locale));
  if (typeof window !== 'undefined') {
    window.addEventListener('languagechange', () => setSystemLocale(detectLocale()));
    window.addEventListener('focus', () => setPreference(readPreference()));
    window.addEventListener('pageshow', () => setPreference(readPreference()));
    createEffect(locale, value => { document.documentElement.lang = value; });
  }
  return { preference, setPreference, locale };
});

export const locale = state.locale;
export const preference = state.preference;

export function changeLanguage(value: Preference): void {
  state.setPreference(value);
  try { writeSharedPreference(localStorage, STORAGE_KEY, value); }
  catch { /* Private browsing can disable storage. */ }
}

/**
 * Translate an English source string. `{name}` placeholders are replaced by
 * `vars`. English is the fallback when a translation is missing.
 */
export function t(english: string, vars?: Record<string, string | number>): string {
  const current = locale();
  let text = current === 'en' ? english : translations[english]?.[current === 'pt' ? 0 : 1] || english;
  if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

/** Choose a singular or plural source string by count, then translate. */
export function tn(count: number, one: string, other: string, vars?: Record<string, string | number>): string {
  return t(count === 1 ? one : other, { count, ...vars });
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: unit < 2 ? 0 : 1 }).format(value)} ${units[unit]}`;
}

export function formatDate(value: string | number | undefined): string {
  if (value === undefined) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(date);
}

/** Native language names for chapter-language choices. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames([locale()], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
