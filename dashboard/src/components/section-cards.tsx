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
  const t = stats.totals;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        ["Tasks total", t.tasks, `${t.active} active · ${t.paused} paused`],
        ["Healthy", t.healthy, "Tasks running on schedule"],
        [
          "Open incidents",
          t.open_incidents,
          `${t.with_open_incidents} tasks need attention`,
        ],
        [
          "Heartbeats 24h",
          t.heartbeats_24h,
          `${t.failed_heartbeats_24h} failed`,
        ],
      ].map(([title, value, detail]) => (
        <Card key={title}>
          <CardHeader>
            <CardDescription>{title}</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{detail}</Badge>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
