import { en, type TranslationKey } from "./i18n/en";
import zhCN from "./i18n/zh-CN";
import type { ScheduleItem } from "./api";
export function taskStatus(
  task: Pick<ScheduleItem, "paused" | "last_status" | "open_incidents">,
) {
  if (task.paused) return "Paused";
  if (task.open_incidents.some((i) => i.kind === "deliverable_missing"))
    return "Deliverable missing";
  if (
    task.last_status === "fail" ||
    task.open_incidents.some((i) => i.kind === "failed")
  )
    return "Failing";
  if (task.open_incidents.some((i) => i.kind === "missed")) return "Missed";
  return "Healthy";
}
export function saneCron(value: string) {
  const fields = value.trim().split(/\s+/);
  const bounds = [59, 23, 31, 12, 7];
  return (
    fields.length === 5 &&
    fields.every((f, i) =>
      f.split(",").every((part) => {
        const [range, step, ...extra] = part.split("/");
        if (
          extra.length ||
          (step !== undefined && (!/^\d+$/.test(step) || +step < 1))
        )
          return false;
        if (range === "*") return true;
        const nums = range.split("-");
        return (
          nums.length <= 2 &&
          nums.every(
            (n) =>
              /^\d+$/.test(n) &&
              +n >= (i === 2 || i === 3 ? 1 : 0) &&
              +n <= bounds[i],
          ) &&
          (nums.length < 2 || +nums[0] <= +nums[1])
        );
      }),
    )
  );
}
export function relative(value: string | null, locale: "en" | "zh-CN" = "en") {
  if (!value) return locale === "zh-CN" ? zhCN.Never : en.Never;
  const seconds = (Date.parse(value) - Date.now()) / 1000;
  const unit =
    Math.abs(seconds) < 3600
      ? "minute"
      : Math.abs(seconds) < 86400
        ? "hour"
        : "day";
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / { minute: 60, hour: 3600, day: 86400 }[unit]),
    unit,
  );
}
export const message = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong";

export function humanizeIncident(value: string | null, locale: "en" | "zh-CN" = "en") {
  if (value === null) return locale === "zh-CN" ? zhCN.Open : en.Open;
  const labels: Record<string, string> = {
    rerun_ok: "Re-run OK",
    deliverable_ok: "Deliverable OK",
  };
  const key = labels[value] ?? value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
  return locale === "zh-CN" && Object.hasOwn(en, key) ? zhCN[key as TranslationKey] : key;
}
export function incidentVariant(value: string | null) {
  return value === "failed" || value === "missed"
    ? "destructive" as const
    : value === "deliverable_missing" || value === "unknown" || value === null || value === "none"
      ? "outline" as const
      : "secondary" as const;
}
export const incidentClassName = (value: string | null) =>
  value === "deliverable_missing" || value === "unknown"
    ? "border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : undefined;
