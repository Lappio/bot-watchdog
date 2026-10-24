import { ApiError } from "../api";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { en, type TranslationKey } from "./en";
import zhCN from "./zh-CN";
import { relative } from "../helpers";
export type Locale = "en" | "zh-CN";
export function isTranslationKey(value: string): value is TranslationKey {
  return Object.hasOwn(en, value);
}
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;
export function detectLocale(): Locale {
  const saved = localStorage.getItem("bw_locale");
  return saved === "en" || saved === "zh-CN" ? saved : navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
export function translate(locale: Locale, key: TranslationKey, params: Record<string, string | number> = {}) {
  return (locale === "zh-CN" ? zhCN : en)[key].replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
function useLocaleValue(locale: Locale, setLocale: (locale: Locale) => void) {
  const t: Translate = useCallback((key, params) => translate(locale, key, params), [locale]);
  return useMemo(() => ({
    locale, setLocale, t,
    formatError: (error: unknown) => error instanceof ApiError ? t("Request failed ({status})", { status: error.status }) : t("Something went wrong"),
    // Only use label for known UI enums, never for user-provided data.
    label: (value: string) => isTranslationKey(value) ? t(value) : value,
    plural: (one: TranslationKey, other: TranslationKey, count: number, params: Record<string, string | number> = {}) => t(new Intl.PluralRules(locale).select(count) === "one" ? one : other, { ...params, count: new Intl.NumberFormat(locale).format(count) }),
    formatRelative: (value: string | null) => relative(value, locale),
    formatDateTime: (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)),
    formatDate: (value: string) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(value)),
    formatNumber: (value: number) => new Intl.NumberFormat(locale).format(value),
  }), [locale, setLocale, t]);
}
const I18nContext = createContext<ReturnType<typeof useLocaleValue> | null>(null);
export function I18nProvider({ children, initialLocale }: { children: React.ReactNode; initialLocale?: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? detectLocale());
  const value = useLocaleValue(locale, setLocale);
  useEffect(() => {
    localStorage.setItem("bw_locale", locale);
    document.documentElement.lang = locale;
    document.title = value.t("Dashboard title");
  }, [locale, value]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n requires I18nProvider");
  return value;
}
