import { useI18n } from "@/lib/i18n";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Stats } from "@/lib/api";
export function SectionCards({ stats }: { stats: Stats }) {
  const { t: translate, label, plural, formatNumber } = useI18n();
  const t = stats.totals;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        ["Tasks total", t.tasks, translate("{active} active · {paused} paused", { active: formatNumber(t.active), paused: formatNumber(t.paused) })],
        ["Healthy", t.healthy, "Tasks running on schedule"],
        [
          "Open incidents",
          t.open_incidents,
          plural("{count} task needs attention", "{count} tasks need attention", t.with_open_incidents),
        ],
        [
          "Heartbeats 24h",
          t.heartbeats_24h,
          translate("{count} failed", { count: formatNumber(t.failed_heartbeats_24h) }),
        ],
      ].map(([title, value, detail]) => (
        <Card key={title}>
          <CardHeader>
            <CardDescription>{label(String(title))}</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{formatNumber(Number(value))}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{label(String(detail))}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
