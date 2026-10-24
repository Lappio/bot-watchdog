import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type Incident, type Task } from "@/lib/api";
import { humanizeIncident, incidentVariant, incidentClassName } from "@/lib/helpers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
export function Incidents({
  taskId,
  tasks,
  version,
  onChanged,
}: {
  taskId?: string;
  tasks: Task[];
  version: number;
  onChanged: () => void;
}) {
  const { t, label, locale, formatDateTime, formatError } = useI18n();
  const [status, setStatus] = useState(taskId ? "all" : "open");
  const [rows, setRows] = useState<Incident[]>();
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<Incident | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setError(null);
    setRows(undefined);
    api<{ incidents: Incident[] }>(
      `/incidents?status=${status}&limit=500${taskId ? `&task_id=${encodeURIComponent(taskId)}` : ""}`,
    )
      .then((r) => {
        if (active) setRows(r.incidents);
      })
      .catch((e) => {
        if (active) setError(e);
      });
    return () => {
      active = false;
    };
  }, [status, taskId, version]);
  async function rerun() {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; status: string }>(
        `/incidents/${confirm.id}/rerun`,
        { method: "POST" },
      );
      toast.success(t("Re-run: {status}", { status: humanizeIncident(r.status, locale) }));
    } catch (e) {
      toast.error(formatError(e));
    } finally {
      setBusy(false);
      setConfirm(null);
      onChanged();
    }
  }
  const content = (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {formatError(error)}
            <Button variant="link" onClick={onChanged}>
              {t("Retry")}</Button>
          </AlertDescription>
        </Alert>
      ) : !rows ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Task",
                  "Bot",
                  "Kind",
                  "Expected at",
                  "Opened",
                  "Alert",
                  "Re-run",
                  "Resolution",
                  "",
                ].map((h, i) => (
                  <TableHead key={i}>{label(h)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <a
                      href={`#/tasks/${i.task_id}`}
                      className="font-medium hover:underline"
                    >
                      {i.task_name ??
                        tasks.find((t) => t.id === i.task_id)?.name ??
                        i.task_id}
                    </a>
                  </TableCell>
                  <TableCell>
                    {i.task_bot ??
                      tasks.find((t) => t.id === i.task_id)?.bot ??
                      "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={incidentVariant(i.kind)} className={incidentClassName(i.kind)}>{humanizeIncident(i.kind, locale)}</Badge>
                  </TableCell>
                  <TableCell>
                    {formatDateTime(i.expected_at)}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(i.opened_at)}
                  </TableCell>
                  <TableCell>
                    {i.alert_error ? <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{humanizeIncident(i.alert_status, locale)}</span></TooltipTrigger><TooltipContent>{t("Alert error: {error}", { error: i.alert_error })}</TooltipContent></Tooltip> : humanizeIncident(i.alert_status, locale)}
                  </TableCell>
                  <TableCell>
                    {i.rerun_error ? <Tooltip><TooltipTrigger asChild><span tabIndex={0}><Badge variant={incidentVariant(i.rerun_status)} className={incidentClassName(i.rerun_status)}>{humanizeIncident(i.rerun_status, locale)}</Badge></span></TooltipTrigger><TooltipContent>{t("Re-run error: {error}", { error: i.rerun_error })}</TooltipContent></Tooltip> : <Badge variant={incidentVariant(i.rerun_status)} className={incidentClassName(i.rerun_status)}>{humanizeIncident(i.rerun_status, locale)}</Badge>}
                  </TableCell>
                  <TableCell><Badge variant={incidentVariant(i.resolution)}>{humanizeIncident(i.resolution, locale)}</Badge></TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span tabIndex={!tasks.find((t) => t.id === i.task_id)?.has_rerun_webhook ? 0 : undefined}>
                    <Button
                      className="shrink-0 whitespace-nowrap"
                      variant="outline"
                      size="sm"
                      disabled={
                        busy ||
                        !tasks.find((t) => t.id === i.task_id)
                          ?.has_rerun_webhook ||
                        !!i.resolved_at ||
                        !!i.rerun_requested_at ||
                        i.rerun_status !== "none"
                      }
                      onClick={() => setConfirm(i)}
                    >
                      {t("Re-run")}</Button>
                        </span>
                      </TooltipTrigger>
                      {!tasks.find((t) => t.id === i.task_id)?.has_rerun_webhook && <TooltipContent>{t("No re-run webhook configured")}</TooltipContent>}
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="h-32 text-center text-muted-foreground"
                  >
                    {t("No incidents.")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
  return (
    <>
      <Tabs value={status} onValueChange={setStatus}>
        <TabsList>
          <TabsTrigger value="open">{t("Open")}</TabsTrigger>
          <TabsTrigger value="all">{t("All")}</TabsTrigger>
        </TabsList>
        <TabsContent value={status}>{content}</TabsContent>
      </Tabs>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Re-run this task?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("This will POST the task's webhook once. It will never auto-retry.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void rerun();
              }}
            >
              {busy ? t("Requesting…") : t("Confirm re-run")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
