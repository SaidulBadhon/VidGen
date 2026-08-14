/**
 * Translation provider.
 *
 * The locale files are the same flat `{"Translation": {...}}` maps the Streamlit
 * UI used, carried over unchanged. With ~300 flat keys and no plurals or
 * interpolation beyond `{name}` placeholders, i18next would be more machinery
 * than this needs.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import bn from "./locales/bn.json";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import id from "./locales/id.json";
import pt from "./locales/pt.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import vi from "./locales/vi.json";
import zh from "./locales/zh.json";

type LocaleFile = { Translation?: Record<string, string> } & Record<string, unknown>;

const RAW_LOCALES: Record<string, LocaleFile> = { bn, de, en, es, id, pt, ru, tr, vi, zh };

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  zh: "简体中文",
  bn: "বাংলা",
  de: "Deutsch",
  es: "Español",
  id: "Bahasa Indonesia",
  pt: "Português",
  ru: "Русский",
  tr: "Türkçe",
  vi: "Tiếng Việt",
};

export const SUPPORTED_LANGUAGES = Object.keys(RAW_LOCALES).sort();

const LOCALES: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(RAW_LOCALES).map(([code, file]) => [code, (file.Translation ?? file) as Record<string, string>]),
);

const STORAGE_KEY = "mpt.language";

/**
 * Strips Streamlit-only markup from a translation.
 *
 * The locale files were authored for Streamlit, which rendered its values as
 * markdown, so many carry `**bold**` and `:blue[...]` colour directives. Those
 * are meaningless here and would otherwise be shown literally. Cleaning them at
 * lookup time keeps the files byte-identical to the originals, so translations
 * can still be diffed against upstream.
 */
function stripStreamlitMarkup(value: string): string {
  return value
    .replace(/:(?:blue|red|green|orange|violet|gray|grey|rainbow)\[([^\]]*)\]/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

/**
 * Resolves the initial language: saved choice, then browser locale, then
 * English. Browsers report region-qualified locales, so the base code is tried
 * as a fallback.
 */
function resolveInitialLanguage(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && LOCALES[saved]) return saved;

  for (const candidate of navigator.languages ?? [navigator.language]) {
    const normalized = candidate.toLowerCase().replace(/_/g, "-");
    if (LOCALES[normalized]) return normalized;
    const base = normalized.split("-")[0]!;
    if (LOCALES[base]) return base;
  }
  return "en";
}

/**
 * Translates a key in a named language rather than the one being displayed.
 *
 * Most text follows the UI language, but some is spoken or read in a language
 * the user is not currently reading — a voice sample belongs in the *voice's*
 * language, not the interface's. The locale files already carry those strings,
 * so this reads them from there instead of hardcoding a sentence per language.
 */
export function translateIn(
  language: string,
  key: string,
  vars?: Record<string, string | number>,
): string {
  // Non-English files are incomplete; English backfills them so a missing
  // translation shows real text rather than a raw key.
  let value = stripStreamlitMarkup(LOCALES[language]?.[key] ?? LOCALES.en?.[key] ?? key);
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
  }
  return value;
}

interface I18nValue {
  language: string;
  setLanguage: (language: string) => void;
  /** Translates a key, falling back to English and then to the key itself. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState(resolveInitialLanguage);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translateIn(language, key, vars),
    [language],
  );

  const value = useMemo<I18nValue>(
    () => ({ language, setLanguage: setLanguageState, t }),
    [language, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
