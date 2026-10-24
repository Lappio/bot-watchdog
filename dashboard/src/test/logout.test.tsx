import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import App from "@/App";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  location.hash = "";
});

it.each([
  ["en", "Log out", "Refresh", "Sign in", "Choose language", "Choose theme"],
  ["zh-CN", "退出登录", "刷新", "登录", "选择语言", "选择主题"],
])("places logout first in the %s header and returns to login", async (locale, logoutLabel, refreshLabel, loginLabel, languageLabel, themeLabel) => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  localStorage.setItem("bw_locale", locale);
  localStorage.setItem("bw_admin_token", "test");
  location.hash = "#/settings";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("/stats") ? { totals: {}, series: [] } : { tasks: [] })));
  const { container } = render(<App />);
  const header = screen.getByRole("banner");
  const logout = within(header).getByRole("button", { name: logoutLabel });
  expect(logout).toHaveTextContent(logoutLabel);
  expect(logout).toHaveAttribute("aria-label", logoutLabel);
  const refresh = within(header).getByRole("button", { name: refreshLabel });
  const controls = within(logout.parentElement!).getAllByRole("button");
  expect(controls).toEqual([
    logout,
    refresh,
    within(header).getByRole("button", { name: languageLabel }),
    within(header).getByRole("button", { name: themeLabel }),
  ]);
  const sidebar = container.querySelector('[data-sidebar="sidebar"]');
  expect(sidebar).not.toBeNull();
  expect(within(sidebar as HTMLElement).queryByRole("button", { name: logoutLabel })).not.toBeInTheDocument();
  fireEvent.focus(logout);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(logoutLabel);
  fireEvent.click(logout);
  expect(localStorage.getItem("bw_admin_token")).toBeNull();
  expect(screen.getByRole("button", { name: loginLabel })).toBeInTheDocument();
  expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: logoutLabel })).not.toBeInTheDocument();
});
