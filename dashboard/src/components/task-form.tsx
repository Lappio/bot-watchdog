import { useState } from "react";
import { z } from "zod";
import { api, type Task, type Credentials } from "@/lib/api";
import { saneCron, message } from "@/lib/helpers";
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
  name: z.string().trim().min(1).max(100),
  bot: z.string().max(100),
  schedule: z
    .string()
    .refine(saneCron, "Use a valid five-field cron expression"),
  timezone: z.string().min(1),
  grace_minutes: z.coerce.number().int().min(1).max(1440),
  alert_channel: z.enum(["telegram", "email"]),
  alert_target: z.string().min(1),
  rerun_webhook_url: z.string(),
  rerun_webhook_secret: z.string().max(512),
  paused: z.boolean(),
  deliverable_check: z.enum(["none", "http", "github"]),
  deliverable_config: z.string(),
  deliverable_delay_minutes: z.coerce.number().int().min(0).max(1440),
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function field(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  const input = (key: keyof typeof form, label: string, type = "text") => (
    <div className="space-y-2">
      <Label htmlFor={key}>{label}</Label>
      <Input
        id={key}
        type={type}
        min={key === "grace_minutes" ? 1 : 0}
        max={type === "number" ? 1440 : undefined}
        value={String(form[key])}
        onChange={(e) => field(key, e.target.value)}
      />
    </div>
  );
  const select = (key: keyof typeof form, label: string, values: string[]) => (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={String(form[key])} onValueChange={(v) => field(key, v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const parsed = schema.parse(form);
      const config: unknown = parsed.deliverable_check === "none" ? {} : JSON.parse(parsed.deliverable_config);
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("Deliverable config must be a JSON object");
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
      setError(
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : message(e),
      );
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
          <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Configure the schedule and where to send alerts.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {input("name", "Name")}
            {input("bot", "Bot")}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">Schedule</h3>
            {input("schedule", "Schedule (cron)")}
            {select(
              "timezone",
              "Timezone",
              Array.from(new Set([form.timezone, ...zones])),
            )}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Five fields: minute hour day-of-month month day-of-week. Example:
              0 9 * * * runs daily at 09:00.
            </p>
            {input("grace_minutes", "Grace minutes", "number")}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">Alerts</h3>
            {select("alert_channel", "Alert channel", ["telegram", "email"])}
            {input("alert_target", "Alert target")}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">Re-run</h3>
            {input("rerun_webhook_url", "Re-run webhook URL", "url")}
            {input(
              "rerun_webhook_secret",
              task ? "Webhook secret (blank = unchanged)" : "Webhook secret",
              "password",
            )}
            <Separator className="sm:col-span-2" />
            <h3 className="font-medium sm:col-span-2">Deliverable check</h3>
            {select("deliverable_check", "Deliverable check", [
              "none",
              "http",
              "github",
            ])}
            {form.deliverable_check !== "none" && input(
              "deliverable_delay_minutes",
              "Deliverable delay minutes",
              "number",
            )}
          </div>
          {form.deliverable_check !== "none" && <div className="space-y-2">
            <Label htmlFor="config">Deliverable config (JSON object)</Label>
            <Textarea
              id="config"
              className="font-mono"
              rows={4}
              value={form.deliverable_config}
              onChange={(e) => field("deliverable_config", e.target.value)}
            />
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
              <Label htmlFor="paused">Paused</Label>
            </div>
          )}
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : "Save task"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
