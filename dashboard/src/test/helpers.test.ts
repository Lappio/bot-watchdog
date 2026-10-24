import { describe, it, expect } from "vitest";
import { saneCron, taskStatus, humanizeIncident, incidentVariant, incidentClassName } from "@/lib/helpers";
describe("cron sanity", () => {
  it.each(["* * * * *", "0 9 * * 1-5", "*/15 0,12 1-31 1-12 0-7"])(
    "accepts %s",
    (value) => expect(saneCron(value)).toBe(true),
  );
  it.each([
    "* * * *",
    "60 0 * * *",
    "0 24 * * *",
    "*/0 * * * *",
    "0 0 0 * *",
    "x * * * *",
    "5-1 * * * *",
  ])("rejects %s", (value) => expect(saneCron(value)).toBe(false));
});
describe("task status", () => {
  const base = { paused: false, last_status: null, open_incidents: [] };
  it("treats no failures as healthy", () =>
    expect(taskStatus(base)).toBe("Healthy"));
  it("uses last failure", () =>
    expect(taskStatus({ ...base, last_status: "fail" })).toBe("Failing"));
  it.each([
    ["missed", "Missed"],
    ["failed", "Failing"],
    ["deliverable_missing", "Deliverable missing"],
  ] as const)("derives %s", (kind, status) =>
    expect(
      taskStatus({
        ...base,
        open_incidents: [
          {
            id: "i",
            kind,
            expected_at: "",
            opened_at: "",
            alert_status: "sent",
          },
        ],
      }),
    ).toBe(status),
  );
  it("gives paused precedence", () =>
    expect(taskStatus({ ...base, paused: true, last_status: "fail" })).toBe(
      "Paused",
    ));
});

describe("incident labels", () => {
  it.each([
    ["missed", "Missed"], ["failed", "Failed"],
    ["deliverable_missing", "Deliverable missing"],
    ["late_heartbeat", "Late heartbeat"], ["rerun_ok", "Re-run OK"],
    ["deliverable_ok", "Deliverable OK"], ["recovered", "Recovered"],
    ["none", "None"], ["requested", "Requested"], ["succeeded", "Succeeded"],
    ["unknown", "Unknown"], [null, "Open"],
  ])("humanizes %s", (value, label) => expect(humanizeIncident(value)).toBe(label));
});

it("uses destructive badges for failed and missed incidents and amber for missing deliverables", () => {
  expect(incidentVariant("failed")).toBe("destructive");
  expect(incidentVariant("missed")).toBe("destructive");
  expect(incidentVariant("deliverable_missing")).toBe("outline");
  expect(incidentClassName("deliverable_missing")).toContain("amber");
});
