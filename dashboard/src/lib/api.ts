export interface Task {
  id: string;
  name: string;
  bot: string | null;
  schedule: string;
  timezone: string;
  grace_minutes: number;
  alert_channel: "telegram" | "email";
  alert_target: string;
  rerun_webhook_url: string | null;
  has_rerun_webhook: boolean;
  schedule_anchor_at: string | null;
  paused: boolean;
  created_at: string;
  updated_at: string;
  last_heartbeat_at: string | null;
  deliverable_check: "none" | "http" | "github";
  deliverable_config: Record<string, unknown> | null;
  deliverable_delay_minutes: number;
  last_status: "ok" | "fail" | null;
}
export interface Incident {
  id: string;
  task_id: string;
  task_name?: string;
  task_bot?: string | null;
  kind: "missed" | "failed" | "deliverable_missing";
  expected_at: string;
  opened_at: string;
  resolved_at: string | null;
  resolution:
    "late_heartbeat" | "rerun_ok" | "recovered" | "deliverable_ok" | null;
  alert_status: "pending" | "sent" | "failed";
  alert_error: string | null;
  recovery_notice_status: "sent" | "failed" | null;
  recovery_notice_error: string | null;
  rerun_requested_at: string | null;
  rerun_status: "none" | "requested" | "succeeded" | "failed" | "unknown";
  rerun_unknown_alert_status: "sent" | "failed" | null;
  rerun_unknown_alert_error: string | null;
  occurrence_count: number;
  last_occurrence_at: string | null;
  last_reminder_at: string | null;
  reminder_claim_until: string | null;
  rerun_response_code: number | null;
  rerun_error: string | null;
}
export interface ScheduleItem extends Pick<
  Task,
  | "id"
  | "name"
  | "bot"
  | "schedule"
  | "timezone"
  | "grace_minutes"
  | "paused"
  | "last_heartbeat_at"
  | "last_status"
  | "schedule_anchor_at"
  | "created_at"
  | "deliverable_check"
> {
  next_run: string | null;
  open_incidents: Pick<
    Incident,
    "id" | "kind" | "expected_at" | "opened_at" | "alert_status"
  >[];
}
export interface Heartbeat {
  id: string;
  task_id: string;
  received_at: string;
  status: "ok" | "fail";
  run_id: string | null;
  output_url: string | null;
  message: string | null;
  dropped_fields: string | null;
}
export interface Stats {
  generated_at: string;
  totals: {
    tasks: number;
    active: number;
    paused: number;
    healthy: number;
    with_open_incidents: number;
    open_incidents: number;
    heartbeats_24h: number;
    failed_heartbeats_24h: number;
  };
  series: {
    date: string;
    ok: number;
    fail: number;
    incidents_opened: number;
  }[];
}
export interface Credentials {
  snippet: string;
  heartbeat_url: string;
  ping_token: string;
}
export interface Runs {
  runs: Heartbeat[];
  next_before: string | null;
  incidents: Incident[];
}
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const TOKEN_KEY = "bw_admin_token";
export async function api<T>(
  path: string,
  options: RequestInit = {},
  text = false,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set(
    "Authorization",
    `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ""}`,
  );
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event("bw-unauthorized"));
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return text ? ((await response.text()) as T) : ((await response.json()) as T);
}
