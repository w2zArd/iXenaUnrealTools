import { coreTranslations } from './locales/core';

export type UiLanguage = 'en' | 'zh-CN';
export type LanguagePreference = 'auto' | UiLanguage;

// Pure module: model code and tests do not need to import the VSCode host.
const translations: Record<string, string> = Object.assign(Object.create(null), coreTranslations);
let language: UiLanguage = 'zh-CN';
const listeners = new Set<() => void>();

export function resolveLanguage(preference: unknown, editorLanguage = 'en'): UiLanguage {
  if (preference === 'en' || preference === 'zh-CN') return preference;
  return /^zh(?:[-_]|$)/i.test(editorLanguage) ? 'zh-CN' : 'en';
}

export function configureI18n(preference: unknown, editorLanguage?: string): void {
  const next = resolveLanguage(preference, editorLanguage);
  if (next === language) return;
  language = next;
  for (const listener of [...listeners]) listener();
}

export function getLanguage(): UiLanguage { return language; }

export function registerTranslations(values: Readonly<Record<string, string>>): void {
  for (const [source, translated] of Object.entries(values)) {
    if (typeof translated === 'string') translations[source] = translated;
  }
}

export function onDidChangeLanguage(listener: () => void): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => { listeners.delete(listener); } };
}

function format(value: string, args: readonly unknown[]): string {
  // Replace only catalog placeholders; never interpret braces in user arguments.
  return value.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match);
}

/** Chinese source strings are stable translation keys. Unknown keys keep readable source text. */
export function t(source: string, ...args: unknown[]): string {
  return format(language === 'en' ? translations[source] ?? source : source, args);
}

/** Bilingual helper for small feature-local resources; same safe placeholder formatting. */
export function tr(chinese: string, english: string, ...args: unknown[]): string {
  return format(language === 'en' ? english : chinese, args);
}
