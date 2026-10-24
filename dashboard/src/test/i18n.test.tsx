import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { en, type Dictionary } from "@/lib/i18n/en";
import zhCN from "@/lib/i18n/zh-CN";
import { detectLocale, I18nProvider, translate, useI18n } from "@/lib/i18n";
import { Toaster } from "@/components/ui/sonner";
import { DataTable } from "@/components/data-table";
import { LanguageToggle } from "@/components/language-toggle";
import { LoginCard } from "@/components/auth";
import { TaskForm } from "@/components/task-form";
import App from "@/App";
import { relative, humanizeIncident } from "@/lib/helpers";

function flatten(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, text]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof text === "string" ? [[path, text]] : Object.entries(flatten(text, path));
  }));
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  location.hash = "";
});

it("requires identical dictionary keys, nonempty text, and matching interpolation parameters", () => {
  const english = flatten(en), chinese = flatten(zhCN);
  expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  for (const [key, text] of Object.entries(english)) {
    expect(text.trim(), key).not.toBe("");
    expect(chinese[key].trim(), key).not.toBe("");
    const params = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(params(chinese[key]), key).toEqual(params(text));
  }
  // Compile-time parity checks complement the runtime flattened-key check.
  // @ts-expect-error A missing English key must fail typechecking.
  const missing: Dictionary = { Overview: "概览" };
  // @ts-expect-error Additional Chinese keys must fail typechecking.
  const extra: Dictionary = { ...zhCN, nonexistent: "额外" };
  void missing; void extra;
});

describe("default locale detection", () => {
  it.each([["zh", "zh-CN"], ["zh-TW", "zh-CN"], ["zh-CN", "zh-CN"], ["en-US", "en"], ["fr-FR", "en"]])("detects %s as %s", (language, expected) => {
    vi.spyOn(navigator, "language", "get").mockReturnValue(language);
    expect(detectLocale()).toBe(expected);
  });
  it("prefers a saved language and ignores invalid saved values", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    localStorage.setItem("bw_locale", "en");
    expect(detectLocale()).toBe("en");
    localStorage.setItem("bw_locale", "bad");
    expect(detectLocale()).toBe("zh-CN");
  });
});

function FormattingSample() {
  const { t, plural, formatRelative, formatNumber, formatDateTime, formatDate } = useI18n();
  return <div><p>{t("Overview")}</p><p>{formatRelative("2026-10-24T00:11:00Z")}</p><p>{formatNumber(12345)}</p><p>{formatDateTime("2026-10-24T00:11:00Z")}</p><p>{formatDate("2026-10-24")}</p><p>{plural("{count} day", "{count} days", 1)}</p><p>{plural("{count} day", "{count} days", 2)}</p><LanguageToggle /></div>;
}
it("switches language, formatting, html lang and title, persists it, and restores it on remount", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-24T00:00:00Z"));
  const view = render(<I18nProvider initialLocale="en"><FormattingSample /></I18nProvider>);
  expect(screen.getByText("in 11 minutes")).toBeInTheDocument();
  expect(screen.getByText("1 day")).toBeInTheDocument();
  expect(screen.getByText("2 days")).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Choose language" }), { button: 0, ctrlKey: false });
  expect(screen.getByRole("menuitemradio", { name: "English" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: "简体中文" }));
  expect(screen.getByText("概览")).toBeInTheDocument();
  expect(screen.getByText("11分钟后")).toBeInTheDocument();
  expect(screen.getByText("10月24日")).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(document.title).toBe("bot-watchdog 仪表盘");
  expect(localStorage.getItem("bw_locale")).toBe("zh-CN");
  view.unmount();
  render(<I18nProvider><FormattingSample /></I18nProvider>);
  expect(screen.getByRole("button", { name: "选择语言" })).toHaveTextContent("中");
  fireEvent.pointerDown(screen.getByRole("button", { name: "选择语言" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
  expect(document.documentElement.lang).toBe("en");
  expect(document.title).toBe("bot-watchdog Dashboard");
  expect(localStorage.getItem("bw_locale")).toBe("en");
});

it("renders the authenticated task shell in Chinese with mocked API data and keeps user data unchanged", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-24T00:00:00Z"));
  localStorage.setItem("bw_locale", "zh-CN");
  localStorage.setItem("bw_admin_token", "test");
  location.hash = "#/tasks";
  const task = { id: "one", name: "Healthy", bot: "Tasks", schedule: "0 9 * * *", timezone: "UTC", paused: false, last_status: null, next_run: "2026-10-24T00:11:00Z", last_heartbeat_at: "2026-10-23T23:52:00Z", open_incidents: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("/stats") ? { totals: {}, series: [] } : { tasks: [task] })));
  render(<App />);
  expect(await screen.findByRole("button", { name: "新建任务" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "任务" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "概览" })).toBeInTheDocument();
  expect(screen.getByText("11分钟后")).toBeInTheDocument();
  expect(screen.getByText("8分钟前")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Healthy" })).toBeInTheDocument();
  expect(within(screen.getByRole("table")).getByText("Tasks")).toBeInTheDocument();
  expect(screen.getByText("1 个任务 · 第 1 页，共 1 页")).toBeInTheDocument();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Healthy的操作" }), { button: 0, ctrlKey: false });
  expect(screen.getByRole("menuitem", { name: "暂停" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "暂停" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent("暂停“Healthy”？");
  expect(screen.getByRole("button", { name: "确认暂停" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Healthy的操作" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: "查看" }));
  expect(location.hash).toBe("#/tasks/one");
});

it("interpolates parameter values without translating user data", () => {
  expect(translate("zh-CN", "Delete {name}?", { name: "Healthy" })).toBe("删除“Healthy”？");
});
it("formats relative time and incident labels with an explicit locale", () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-24T00:00:00Z"));
  expect(relative(null, "zh-CN")).toBe("从未");
  expect(relative(null, "en")).toBe("Never");
  expect(relative("2026-10-24T00:11:00Z", "en")).toBe("in 11 minutes");
  expect(relative("2026-10-23T23:52:00Z", "en")).toBe("8 minutes ago");
  expect(relative("2026-10-23T23:52:00Z", "zh-CN")).toBe("8分钟前");
  expect(humanizeIncident("rerun_ok", "zh-CN")).toBe("补跑成功");
  expect(humanizeIncident("late_heartbeat", "zh-CN")).toBe("心跳迟到");
  expect(humanizeIncident(null, "zh-CN")).toBe("未关闭");
});

it("provides the language toggle on the login card and translates authentication errors", () => {
  render(<I18nProvider initialLocale="zh-CN"><LoginCard onLogin={() => {}} error="Your token was rejected or expired. Paste ADMIN_TOKEN to sign in again." /></I18nProvider>);
  expect(screen.getByRole("button", { name: "选择语言" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("令牌无效或已过期");
  expect(screen.getByLabelText("粘贴 ADMIN_TOKEN")).toHaveAttribute("type", "password");
});
it("translates form sections and inline validation in Chinese", () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  render(<I18nProvider initialLocale="zh-CN"><TaskForm task={null} onClose={() => {}} onSaved={() => {}} /></I18nProvider>);
  expect(screen.getByRole("heading", { name: "新建任务" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "补跑" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "交付检查" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
  expect(screen.getByLabelText("名称")).toHaveAccessibleDescription("请输入名称");
  expect(screen.getByLabelText("告警目标")).toHaveAccessibleDescription("请输入告警目标");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows the current task status filter in Chinese and updates immediately when switching language", () => {
  render(<I18nProvider initialLocale="zh-CN"><DataTable tasks={[]} onAction={() => {}} onNew={() => {}} /><LanguageToggle /></I18nProvider>);
  expect(screen.getByRole("combobox")).toHaveTextContent("全部");
  fireEvent.pointerDown(screen.getByRole("button", { name: "选择语言" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitemradio", { name: "English" }));
  expect(screen.getByRole("combobox")).toHaveTextContent("All");
});

it.each([["zh-CN", "通知"], ["en", "Notifications"]] as const)("translates the notification region in %s", (locale, name) => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  render(<I18nProvider initialLocale={locale}><Toaster /></I18nProvider>);
  expect(screen.getByRole("region", { name: new RegExp(name) })).toBeInTheDocument();
});
