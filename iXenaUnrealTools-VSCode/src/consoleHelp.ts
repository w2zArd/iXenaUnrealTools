import { getLanguage } from './i18n';
// Shipped with the VSIX and mirrored in the UE plugin's Resources directory.
// Native UE console help is authoritative; Chinese summaries never replace it.
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ConsoleGlossary { schema: number; exact: Record<string, string>; prefixes: Record<string, string>; }
let catalog: ConsoleGlossary | undefined;

function glossary(): ConsoleGlossary {
  if (!catalog) {
    const file = path.join(__dirname, '..', 'resources', 'ConsoleHelp.zh-CN.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || (parsed as ConsoleGlossary).schema !== 1) {
      throw new Error('Invalid iXena console translation catalog');
    }
    catalog = parsed as ConsoleGlossary;
  }
  return catalog;
}

/** Original engine help and parameter details remain visible in all languages. */
export function localizedConsoleHelp(name: string, original: string, locale = getLanguage()): string {
  if (locale !== 'zh-CN') return original;
  const data = glossary();
  const normalized = name.toLowerCase();
  const exact = Object.entries(data.exact).find(([key]) => key.toLowerCase() === normalized)?.[1];
  const prefix = Object.entries(data.prefixes).find(([key]) => normalized.startsWith(key.toLowerCase()))?.[1];
  const description = exact || (prefix ? `分类：${prefix}。具体用途、参数及有效值请参考 UE 原始说明。` : undefined);
  if (!description) return original;
  return original.trim() ? `${description}\n\nUE 原始帮助：\n${original}` : description;
}

export function consoleHelpMatches(name: string, original: string, query: string, locale = getLanguage()): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return name.toLocaleLowerCase().includes(needle) || localizedConsoleHelp(name, original, locale).toLocaleLowerCase().includes(needle);
}
