import { LanguageToggle } from "@/components/language-toggle";
import { I18nProvider, useI18n } from "@/lib/i18n";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  api,
  TOKEN_KEY,
  type Task,
  type ScheduleItem,
  type Stats,
  type Credentials,
} from "@/lib/api";
import { AppSidebar } from "@/components/app-sidebar";
import { LoginCard, ThemeProvider, ThemeToggle } from "@/components/auth";
import { SectionCards } from "@/components/section-cards";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
  BreadcrumbLink,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
const ActivityChart = lazy(() => import("@/components/chart-area-interactive").then((m) => ({ default: m.ActivityChart })));
const DataTable = lazy(() => import("@/components/data-table").then((m) => ({ default: m.DataTable })));
const TaskForm = lazy(() => import("@/components/task-form").then((m) => ({ default: m.TaskForm })));
const TaskDetail = lazy(() => import("@/components/task-detail").then((m) => ({ default: m.TaskDetail })));
const Incidents = lazy(() => import("@/components/incidents").then((m) => ({ default: m.Incidents })));

function Dashboard() {
  const { t, formatError } = useI18n();
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [authError, setAuthError] = useState("");
  const [path, setPath] = useState(() => location.hash.slice(1) || "/");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [schedule, setSchedule] = useState<ScheduleItem[]>([]);
  const [stats, setStats] = useState<Stats>();
  const [days, setDays] = useState("14");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editor, setEditor] = useState<Task | null | undefined>();
  const [credentials, setCredentials] = useState<Credentials>();
  const [deleting, setDeleting] = useState<Task>();
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [pausing, setPausing] = useState<Task>();
  const [pausingBusy, setPausingBusy] = useState(false);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const hash = () => setPath(location.hash.slice(1) || "/");
    const unauthorized = () => {
      setToken(null);
      setAuthError(
        "Your token was rejected or expired. Paste ADMIN_TOKEN to sign in again.",
      );
      setCredentials(undefined);
      setPausing(undefined);
      setDeleting(undefined);
      setEditor(undefined);
      setTasks([]);
      setSchedule([]);
      setStats(undefined);
    };
    window.addEventListener("hashchange", hash);
    window.addEventListener("bw-unauthorized", unauthorized);
    return () => {
      window.removeEventListener("hashchange", hash);
      window.removeEventListener("bw-unauthorized", unauthorized);
    };
  }, []);
  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api<{ tasks: Task[] }>("/tasks"),
      api<{ tasks: ScheduleItem[] }>("/schedule"),
      api<Stats>(`/stats?days=${days}`),
    ])
      .then(([t, s, st]) => {
        if (active) {
          setTasks(t.tasks);
          setSchedule(s.tasks);
          setStats(st);
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
  }, [token, days, version]);
  useEffect(() => {
    if (path !== "/" || !token) return;
    const id = setInterval(refresh, 60000);
    return () => clearInterval(id);
  }, [path, token, refresh]);
  async function copySnippet(id: string) {
    try {
      const text = await api<string>(`/tasks/${id}/snippet`, {}, true);
      await navigator.clipboard.writeText(text);
      toast.success(
        t("Snippet copied. Replace <YOUR_PING_TOKEN> before using it."),
      );
    } catch (e) {
      toast.error(formatError(e));
    }
  }
  const action = useCallback(
    (a: string, id: string) => {
      const task = tasks.find((t) => t.id === id);
      if (!task) return;
      if (a === "View") location.hash = `/tasks/${id}`;
      else if (a === "Edit") setEditor(task);
      else if (a === "Delete") setDeleting(task);
      else if (a === "Pause") setPausing(task);
      else if (a === "Copy snippet") void copySnippet(id);
      else
        void api(`/tasks/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ paused: false }),
        })
          .then(() => {
            toast.success(t("Task resumed"));
            refresh();
          })
          .catch((e) => toast.error(formatError(e)));
    },
    [tasks, refresh, t, formatError],
  );
  if (!token)
    return (
      <LoginCard
        error={authError}
        onLogin={(value) => {
          localStorage.setItem(TOKEN_KEY, value);
          setToken(value);
          refresh();
        }}
      />
    );
  const detailId = path.startsWith("/tasks/") ? path.slice(7) : null;
  const task = tasks.find((t) => t.id === detailId);
  const title = detailId
    ? task?.name ?? t("Task")
    : path === "/tasks"
      ? t("Tasks")
      : path === "/incidents"
        ? t("Incidents")
        : path === "/settings"
          ? t("Settings")
          : t("Overview");
  return (
    <SidebarProvider>
      <AppSidebar path={path} />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 lg:px-6">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#/">bot-watchdog</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              {detailId && <>
                <BreadcrumbItem><BreadcrumbLink href="#/tasks">{t("Tasks")}</BreadcrumbLink></BreadcrumbItem>
                <BreadcrumbSeparator />
              </>}
              <BreadcrumbItem>
                <BreadcrumbPage>{title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="gap-1.5 sm:w-auto sm:px-2.5"
                  aria-label={t("Log out")}
                  onClick={() => {
                    localStorage.removeItem(TOKEN_KEY);
                    setToken(null);
                    setAuthError("");
                    setCredentials(undefined);
                    setPausing(undefined);
                    setDeleting(undefined);
                    setEditor(undefined);
                    setTasks([]);
                    setSchedule([]);
                    setStats(undefined);
                  }}
                >
                  <LogOut />
                  <span className="hidden whitespace-nowrap sm:inline">{t("Log out")}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("Log out")}</TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="icon"
              aria-label={t("Refresh")}
              disabled={loading}
              onClick={refresh}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
            </Button>
            <LanguageToggle /><ThemeToggle />
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-4 lg:p-6">
          {!detailId && <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {path === "/"
                ? t("Your bots, schedules, and delivery health at a glance. Auto-refreshes every 60 seconds.")
                : path === "/tasks"
                  ? t("Manage schedules and heartbeat monitoring.")
                  : path === "/incidents"
                    ? t("Investigate missed runs, failures, and missing deliverables.")
                    : ""}
            </p>
          </div>}
          <Suspense fallback={<Skeleton className="h-72 w-full" />} >
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {formatError(error)}
                <Button variant="link" onClick={refresh}>
                  {t("Retry")}</Button>
              </AlertDescription>
            </Alert>
          ) : loading && !stats ? (
            <>
              <Skeleton className="h-32" />
              <Skeleton className="h-72" />
            </>
          ) : detailId ? (
            task ? (
              <TaskDetail
                key={task.id}
                task={task}
                schedule={schedule.find((s) => s.id === task.id)}
                tasks={tasks}
                onAction={action}
                version={version}
                onChanged={refresh}
              />
            ) : (
              <Alert>
                <AlertDescription>
                  {t("Task not found.")}{" "}<a href="#/tasks">{t("Back to tasks")}</a>
                </AlertDescription>
              </Alert>
            )
          ) : path === "/incidents" ? (
            <Incidents tasks={tasks} version={version} onChanged={refresh} />
          ) : path === "/settings" ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("Browser settings")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {t("Choose your language and theme. Your preferences are saved in this browser. Manage ADMIN_TOKEN through your Worker environment.")}</p>
                <div className="flex items-center justify-between gap-4"><span>{t("Language")}</span><LanguageToggle /></div>
                <div className="flex items-center justify-between gap-4"><span>{t("Theme")}</span><ThemeToggle /></div>
              </CardContent>
            </Card>
          ) : (
            <>
              {path === "/" && stats && (
                <>
                  <SectionCards stats={stats} />
                  <ActivityChart
                    series={stats.series}
                    days={days}
                    onDays={setDays}
                  />
                </>
              )}
              <DataTable
                tasks={schedule}
                onAction={action}
                onNew={() => setEditor(null)}
              />
            </>
          )}
          </Suspense>
        </main>
      </SidebarInset>
      <Suspense fallback={<Skeleton className="h-16" />} >
      {editor !== undefined && (
        <TaskForm
          key={editor?.id ?? "new"}
          task={editor}
          onClose={() => setEditor(undefined)}
          onSaved={(c) => {
            setEditor(undefined);
            if (c) setCredentials(c);
            toast.success(t("Task saved"));
            refresh();
          }}
        />
      )}
      </Suspense>
      <Dialog
        open={!!credentials}
        onOpenChange={(open) => {
          if (!open) setCredentials(undefined);
        }}
      >
        <DialogContent className="max-h-[90svh] overflow-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("Connect your task")}</DialogTitle>
            <DialogDescription>
              {t("The ping token is shown once. Save this snippet and heartbeat URL before closing.")}</DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-xs">
            {credentials?.heartbeat_url}
          </p>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-4 text-xs">
            {credentials?.snippet}
          </pre>
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(credentials!.snippet)
                .then(() => toast.success(t("Snippet copied")))
                .catch(() =>
                  toast.error(
                    t("Clipboard unavailable. Select and copy the snippet."),
                  ),
                );
            }}
          >
            {t("Copy snippet")}</Button>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!pausing} onOpenChange={(open) => {
        if (!open && !pausingBusy) setPausing(undefined);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Pause {name}?", { name: pausing?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("Paused tasks do not trigger missed-run alerts. You can resume monitoring at any time.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pausingBusy}>{t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={pausingBusy} onClick={(event) => {
              event.preventDefault();
              setPausingBusy(true);
              void api(`/tasks/${pausing!.id}`, { method: "PATCH", body: JSON.stringify({ paused: true }) })
                .then(() => {
                  setPausing(undefined);
                  toast.success(t("Task paused"));
                  refresh();
                })
                .catch((error) => toast.error(formatError(error)))
                .finally(() => setPausingBusy(false));
            }}>{t("Confirm pause")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v && !deletingBusy) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete {name}?", { name: deleting?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("This permanently deletes the task and its heartbeats and incidents.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingBusy}>
              {t("Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingBusy}
              onClick={(e) => {
                e.preventDefault();
                setDeletingBusy(true);
                void api(`/tasks/${deleting!.id}`, { method: "DELETE" })
                  .then(() => {
                    setDeleting(undefined);
                    toast.success(t("Task deleted"));
                    if (detailId === deleting?.id) location.hash = "/tasks";
                    refresh();
                  })
                  .catch((e) => toast.error(formatError(e)))
                  .finally(() => setDeletingBusy(false));
              }}
            >
              {t("Delete task")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
export default function App() {
  return (
    <I18nProvider><ThemeProvider>
      <TooltipProvider>
        <Dashboard />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider></I18nProvider>
  );
}
