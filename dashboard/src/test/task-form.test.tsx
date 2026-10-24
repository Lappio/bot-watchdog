import { it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskForm } from "@/components/task-form";
import type { Task } from "@/lib/api";

it("shows accessible inline errors and skips the API for empty fields", () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    render(<TaskForm task={null} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    const name = screen.getByLabelText("Name");
    expect(screen.getByText("Name is required")).toHaveClass("text-destructive", "text-sm");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Name is required");
    expect(screen.getByLabelText("Alert target")).toHaveAccessibleDescription("Alert target is required");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Daily report" } });
    expect(screen.queryByText("Name is required")).not.toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "false");
    expect(name).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("Alert target is required")).toBeInTheDocument();
  } finally { fetchMock.mockRestore(); }
});

it.each([
  ["email", "Enter a valid email address"],
  ["telegram", "Enter a numeric chat id or @channel"],
] as const)("validates %s targets and other fields inline", (channel, targetMessage) => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    render(<TaskForm task={{ name: "Report", alert_channel: channel, alert_target: "invalid", deliverable_check: "http" } as Task} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Schedule (cron)"), { target: { value: "bad" } });
    fireEvent.change(screen.getByLabelText("Grace minutes"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Re-run webhook URL"), { target: { value: "http://example.com" } });
    fireEvent.change(screen.getByLabelText("Deliverable config (JSON object)"), { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    for (const [label, message] of [
      ["Alert target", targetMessage],
      ["Schedule (cron)", "Enter a five-field cron expression, e.g. 0 9 * * *"],
      ["Grace minutes", "Grace minutes must be 1–1440"],
      ["Re-run webhook URL", "Webhook URL must be https (localhost allowed)"],
      ["Deliverable config (JSON object)", "Deliverable config must be a JSON object"],
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(message);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});
