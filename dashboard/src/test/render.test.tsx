import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskForm } from "@/components/task-form";
import { LoginCard } from "@/components/auth";
import { SectionCards } from "@/components/section-cards";
import { Incidents } from "@/components/incidents";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Task, Stats } from "@/lib/api";
it("renders login with password input, error and submit", () => {
  const login = vi.fn();
  render(<LoginCard onLogin={login} error="Token rejected" />);
  const input = screen.getByLabelText("Paste ADMIN_TOKEN");
  expect(input).toHaveAttribute("type", "password");
  expect(screen.getByText("Token rejected")).toBeInTheDocument();
  fireEvent.change(input, { target: { value: " token " } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(login).toHaveBeenCalledWith("token");
});
it("renders actual stats in section cards", () => {
  const stats: Stats = {
    generated_at: "2026-01-01",
    totals: {
      tasks: 12,
      active: 10,
      paused: 2,
      healthy: 9,
      with_open_incidents: 1,
      open_incidents: 3,
      heartbeats_24h: 123,
      failed_heartbeats_24h: 4,
    },
    series: [],
  };
  render(<SectionCards stats={stats} />);
  for (const label of [
    "Tasks total",
    "Healthy",
    "Open incidents",
    "Heartbeats 24h",
    "10 active · 2 paused",
    "4 failed",
    "123",
  ])
    expect(screen.getByText(label)).toBeInTheDocument();
});

it("hides deliverable configuration when no check is selected", () => {
  render(<TaskForm task={null} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.queryByLabelText("Deliverable delay minutes")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Deliverable config (JSON object)")).not.toBeInTheDocument();
  for (const name of ["Schedule", "Alerts", "Re-run", "Deliverable check"])
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
});

it.each(["http", "github"] as const)("shows configuration for %s deliverable checks", (check) => {
  render(<TaskForm task={{ deliverable_check: check } as Task} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByLabelText("Deliverable delay minutes")).toBeInTheDocument();
  expect(screen.getByLabelText("Deliverable config (JSON object)")).toBeInTheDocument();
});
it("humanizes incident values and explains unavailable re-runs", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    incidents: [{
      id: "i", task_id: "t", kind: "deliverable_missing",
      expected_at: "2026-01-01", opened_at: "2026-01-01",
      resolution: "late_heartbeat", rerun_status: "none", alert_status: "sent",
    }],
  })));
  try {
    render(<TooltipProvider><Incidents tasks={[]} version={0} onChanged={() => {}} /></TooltipProvider>);
    expect(await screen.findByText("Deliverable missing")).toHaveAttribute("data-variant", "outline");
    expect(screen.getByText("Late heartbeat")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Re-run" });
    expect(button).toBeDisabled();
    fireEvent.focus(button.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("No re-run webhook configured");
  } finally {
    fetchMock.mockRestore();
  }
});
