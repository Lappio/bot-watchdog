import { useI18n } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import type { Task, ScheduleItem, Heartbeat, Runs, Stats } from "@/lib/api";
import { api } from "@/lib/api";
import { taskStatus } from "@/lib/helpers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ActivityChart } from "./chart-area-interactive";
import { Incidents } from "./incidents";
export function TaskDetail({
  task,
  schedule,
  tasks,
  onAction,
  version,
  onChanged,
}: {
  task: Task;
  schedule?: ScheduleItem;
  tasks: Task[];
  onAction: (action: string, id: string) => void;
  version: number;
  onChanged: () => void;
}) {
  const { t, label, plural, formatDateTime, formatError } = useI18n();
  const [runs, setRuns] = useState<Heartbeat[]>([]);
  const [incidents, setIncidents] = useState<Runs["incidents"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api<Runs>(`/tasks/${task.id}/runs?limit=50`)
      .then((r) => {
        if (active) {
          setRuns(r.runs);
          setIncidents(r.incidents);
          setCursor(r.next_before);
        }
      })
      .catch((e) => {
        if (active) setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.id, version]);
  async function older() {
    setLoading(true);
    setError(null);
    try {
      const r = await api<Runs>(
        `/tasks/${task.id}/runs?limit=50&before=${encodeURIComponent(cursor!)}`,
      );
      setRuns((old) => [...old, ...r.runs]);
      setIncidents((old) => [...new Map([...old, ...r.incidents].map((i) => [i.id, i])).values()]);
      setCursor(r.next_before);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  const series = useMemo(() => {
    const groups = new Map<string, Stats["series"][number]>();
    runs.forEach((r) => {
      const date = r.received_at.slice(0, 10);
      const day = groups.get(date) ?? {
        date,
        ok: 0,
        fail: 0,
        incidents_opened: 0,
      };
      day[r.status]++;
      groups.set(date, day);
    });
    incidents.forEach((incident) => {
      const date = incident.opened_at.slice(0, 10);
      const day = groups.get(date) ?? { date, ok: 0, fail: 0, incidents_opened: 0 };
      day.incidents_opened++;
      groups.set(date, day);
    });
    return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [runs, incidents]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{task.name}</h1>
        <Badge variant="outline">{task.bot ?? t("No bot")}</Badge>
        <Badge>
          {schedule
            ? label(taskStatus(schedule))
            : task.paused
              ? t("Paused")
              : task.last_status === "fail"
                ? t("Failing")
                : t("Healthy")}
        </Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          {["Edit", task.paused ? "Resume" : "Pause", "Copy snippet"].map(
            (a) => (
              <Button
                key={label(a)}
                variant="outline"
                onClick={() => onAction(a, task.id)}
              >
                {label(a)}
              </Button>
            ),
          )}
        </div>
      </div>
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">{t("Runs")}</TabsTrigger>
          <TabsTrigger value="incidents">{t("Incidents")}</TabsTrigger>
          <TabsTrigger value="config">{t("Config")}</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="space-y-4">
          {!!error && (
            <Alert variant="destructive">
              <AlertDescription>
                {formatError(error)}
                <Button variant="link" onClick={onChanged}>
                  {t("Retry")}</Button>
              </AlertDescription>
            </Alert>
          )}
          {runs.length > 0 && <ActivityChart series={series} />}
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "Received",
                    "Status",
                    "Run ID",
                    "Output URL",
                    "Message",
                  ].map((h) => (
                    <TableHead key={h}>{label(h)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      {formatDateTime(r.received_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.status === "ok" ? "secondary" : "destructive"
                        }
                      >
                        {r.status === "ok" ? t("OK") : t("Failed")}
                      </Badge>
                    </TableCell>
                    <TableCell>{r.run_id ?? "—"}</TableCell>
                    <TableCell className="max-w-64 break-all whitespace-normal">
                      {r.output_url ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-80 whitespace-normal">
                      {r.message ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {!runs.length && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center">
                      {t("No runs recorded yet.")}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {loading && <Skeleton className="h-16" />}
          <Button
            variant="outline"
            disabled={loading || !cursor}
            onClick={() => void older()}
          >
            {t("Load older")}</Button>
          <p className="text-xs text-muted-foreground">
            {t("History is retained for 90 days. Runs sharing a cursor timestamp may be skipped at page boundaries.")}</p>
        </TabsContent>
        <TabsContent value="incidents">
          <Incidents
            taskId={task.id}
            tasks={tasks}
            version={version}
            onChanged={onChanged}
          />
        </TabsContent>
        <TabsContent value="config">
          <Card>
            <CardHeader>
              <CardTitle>{t("Task configuration")}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                {Object.entries({
                  Schedule: `${task.schedule} · ${task.timezone}`,
                  Grace: plural("{count} minute", "{count} minutes", task.grace_minutes),
                  "Alert channel": task.alert_channel === "email" ? t("Email") : t("Telegram"),
                  "Alert target": task.alert_target,
                  "Re-run webhook": task.has_rerun_webhook
                    ? t("Configured")
                    : t("None"),
                  "Deliverable check": task.deliverable_check === "none" ? t("None") : task.deliverable_check === "http" ? t("HTTP URL") : t("GitHub"),
                  "Deliverable delay": plural("{count} minute", "{count} minutes", task.deliverable_delay_minutes),
                }).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-sm text-muted-foreground">{label(k)}</dt>
                    <dd className="break-words font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
              <pre className="mt-6 overflow-auto rounded-lg bg-muted p-4 text-xs">
                {JSON.stringify(task.deliverable_config, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
