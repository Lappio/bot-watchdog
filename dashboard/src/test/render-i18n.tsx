import { render as renderTesting, type RenderOptions } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n";
export function render(ui: React.ReactNode, options?: RenderOptions) {
  return renderTesting(<I18nProvider initialLocale="en">{ui}</I18nProvider>, options);
}
