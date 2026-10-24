import { isTranslationKey, useI18n } from "@/lib/i18n";
import { useState } from "react";
import { z } from "zod";
import { api, ApiError, type Task, type Credentials } from "@/lib/api";
import { saneCron } from "@/lib/helpers";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name must be 100 characters or fewer"),
  bot: z.string().max(100),
  schedule: z
    .string()
    .refine(saneCron, "Enter a five-field cron expression, e.g. 0 9 * * *"),
  timezone: z.string().min(1),
  grace_minutes: z.coerce.number().int("Grace minutes must be 1–1440").min(1, "Grace minutes must be 1–1440").max(1440, "Grace minutes must be 1–1440"),
  alert_channel: z.enum(["telegram", "email"]),
  alert_target: z.string().trim().min(1, "Alert target is required"),
  rerun_webhook_url: z.string().trim().refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    } catch { return false; }
  }, "Webhook URL must be https (localhost allowed)"),
  rerun_webhook_secret: z.string().max(512),
  paused: z.boolean(),
  deliverable_check: z.enum(["none", "http", "github"]),
  deliverable_config: z.string(),
  deliverable_delay_minutes: z.coerce.number().int().min(0).max(1440),
}).superRefine((data, ctx) => {
  if (data.alert_target && !(data.alert_channel === "email"
    ? z.email().safeParse(data.alert_target).success
    : /^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(data.alert_target))) {
    ctx.addIssue({ code: "custom", path: ["alert_target"], message: data.alert_channel === "email"
      ? "Enter a valid email address" : "Enter a numeric chat id or @channel" });
  }
  if (data.deliverable_check !== "none") {
    try {
      const config: unknown = JSON.parse(data.deliverable_config);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    } catch {
      ctx.addIssue({ code: "custom", path: ["deliverable_config"], message: "Deliverable config must be a JSON object" });
    }
  }
});
const zones = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["Asia/Shanghai", "America/New_York", "Europe/London"]),
  ]),
);
export function TaskForm({
  task,
  onClose,
  onSaved,
}: {
  task: Task | null;
  onClose: () => void;
  onSaved: (credentials?: Credentials) => void;
}) {
  const { t, label: translateLabel, formatError } = useI18n();
  const [form, setForm] = useState({
    name: task?.name ?? "",
    bot: task?.bot ?? "",
    schedule: task?.schedule ?? "0 9 * * *",
    timezone: task?.timezone ?? "UTC",
    grace_minutes: String(task?.grace_minutes ?? 15),
    alert_channel: task?.alert_channel ?? "telegram",
    alert_target: task?.alert_target ?? "",
    rerun_webhook_url: task?.rerun_webhook_url ?? "",
    rerun_webhook_secret: "",
    paused: task?.paused ?? false,
    deliverable_check: task?.deliverable_check ?? "none",
    deliverable_config: task?.deliverable_config
      ? JSON.stringify(task.deliverable_config, null, 2)
      : "{}",
    deliverable_delay_minutes: String(task?.deliverable_delay_minutes ?? 5),
  });
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof form, string>>>({});
  const [busy, setBusy] = useState(false);
  function field(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined,
      ...(key === "alert_channel" ? { alert_target: undefined } : {}),
      ...(key === "deliverable_check" ? { deliverable_config: undefined } : {}),
    }));
  }
  const errorProps = (key: keyof typeof form) => ({
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `${key}-error` : undefined,
  });
  const fieldError = (key: keyof typeof form) => errors[key] && (
    <p id={`${key}-error`} className="text-destructive text-sm">{translateLabel(errors[key]!)}</p>
  );
  const input = (key: keyof typeof form, label: string, type = "text") => (
    <div className="space-y-2">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        {...errorProps(key)}
        type={type}
        min={key === "grace_minutes" ? 1 : 0}
        max={type === "number" ? 1440 : undefined}
        value={String(form[key])}
        onChange={(e) => field(key, e.target.value)}
      />
      {fieldError(key)}
    </div>
  );
  const select = (key: keyof typeof form, label: string, values: string[], labels: Record<string, string> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={key}>{label}</Label>
      <Select value={String(form[key])} onValueChange={(v) => field(key, v)}>
        <SelectTrigger id={key} className="w-full" {...errorProps(key)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((v) => (
            <SelectItem key={v} value={v}>
              {translateLabel(labels[v] ?? v)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {fieldError(key)}
    </div>
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validation = schema.safeParse(form);
    if (!validation.success) {
      const next: Partial<Record<keyof typeof form, string>> = {};
      for (const issue of validation.error.issues) {
        const key = issue.path[0] as keyof typeof form;
        next[key] ??= isTranslationKey(issue.message) ? issue.message : "Invalid value";
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const parsed = validation.data;
      const config: unknown = parsed.deliverable_check === "none" ? {} : JSON.parse(parsed.deliverable_config);
      const { rerun_webhook_secret, ...rest } = parsed;
      const body = {
        ...rest,
        bot: parsed.bot.trim() || null,
        rerun_webhook_url: parsed.rerun_webhook_url.trim() || null,
        deliverable_config: config,
        ...(!task || rerun_webhook_secret
          ? { rerun_webhook_secret: rerun_webhook_secret || null }
          : {}),
      };
      const result = await api<Credentials>(
        task ? `/tasks/${task.id}` : "/tasks",
        { method: task ? "PATCH" : "POST", body: JSON.stringify(body) },
      );
      onSaved(task ? undefined : result);
    } catch (e) {
      if (e instanceof ApiError) setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{task ? t("Edit task") : t("New task")}</DialogTitle>
          <DialogDescription>
            {t("Configure the schedule and where to send alerts.")}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={save} className="space-y-4">
          {!!error && (
            <Alert variant="destructive">
              <AlertDescription>{formatError(error)}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {input("name", t("Name"))}
            {input("bot", t("Bot"))}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">{t("Schedule")}</h3>
            {input("schedule", t("Schedule (cron)"))}
            {select(
              "timezone",
              t("Timezone"),
              Array.from(new Set([form.timezone, ...zones])),
            )}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t("Five fields: minute hour day-of-month month day-of-week. Example: 0 9 * * * runs daily at 09:00.")}</p>
            {input("grace_minutes", t("Grace minutes"), "number")}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">{t("Alerts")}</h3>
            {select("alert_channel", t("Alert channel"), ["telegram", "email"], { telegram: "Telegram", email: "Email" })}
            {input("alert_target", t("Alert target"))}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">{t("Re-run")}</h3>
            {input("rerun_webhook_url", t("Re-run webhook URL"), "url")}
            {input(
              "rerun_webhook_secret",
              task ? t("Webhook secret (blank = unchanged)") : t("Webhook secret"),
              "password",
            )}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">{t("Deliverable check")}</h3>
            {select("deliverable_check", t("Deliverable check"), [
              "none",
              "http",
              "github",
            ], { none: "None", http: "HTTP URL", github: "GitHub" })}
            {form.deliverable_check !== "none" && input(
              "deliverable_delay_minutes",
              t("Deliverable delay minutes"),
              "number",
            )}
          </div>
          {form.deliverable_check !== "none" && <div className="space-y-2">
            <Label htmlFor="config">{t("Deliverable config (JSON object)")}</Label>
            <Textarea
              id="config"
              {...errorProps("deliverable_config")}
              className="font-mono"
              rows={4}
              value={form.deliverable_config}
              onChange={(e) => field("deliverable_config", e.target.value)}
            />
            {fieldError("deliverable_config")}
            <p className="text-xs text-muted-foreground">
              HTTP: {`{"url":"https://example.com","expect_contains":"ready"}`}.
              GitHub:{" "}
              {`{"type":"file","owner":"org","repo":"reports","path":"daily.md"}`}
              .
            </p>
          </div>}
          {task && (
            <div className="flex items-center gap-3">
              <Switch
                id="paused"
                checked={form.paused}
                onCheckedChange={(v) => field("paused", v)}
              />
              <Label htmlFor="paused">{t("Paused")}</Label>
            </div>
          )}
          <Button disabled={busy} type="submit">
            {busy ? t("Saving…") : t("Save task")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
