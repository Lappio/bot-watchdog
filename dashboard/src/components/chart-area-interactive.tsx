import { useI18n } from "@/lib/i18n";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { Stats } from "@/lib/api";
export function ActivityChart({
  series,
  days,
  onDays,
}: {
  series: Stats["series"];
  days?: string;
  onDays?: (v: string) => void;
}) {
  const { t, plural, formatDate, formatNumber } = useI18n();
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <CardTitle>{t("Run activity")}</CardTitle>
          <CardDescription>
            {t("Daily heartbeats and incidents · UTC")}</CardDescription>
        </div>
        {onDays && (
          <Select value={days} onValueChange={onDays}>
            <SelectTrigger className="w-32" aria-label={t("Run activity")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["7", "14", "30"].map((d) => (
                <SelectItem key={d} value={d}>
                  {plural("{count} day", "{count} days", Number(d))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent>
        <ChartContainer
          className="h-64 w-full"
          config={{
            ok: { label: t("OK"), color: "var(--chart-ok)" },
            fail: { label: t("Failed"), color: "var(--chart-fail)" },
            incidents_opened: {
              label: t("Incidents opened"),
              color: "var(--chart-incident)",
            },
          }}
        >
          <BarChart data={series}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickFormatter={(v) => formatDate(String(v))} />
            <YAxis allowDecimals={false} tickFormatter={formatNumber} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(value) => formatDate(String(value))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            {["ok", "fail", "incidents_opened"].map((key) => (
              <Bar
                key={key}
                stackId={key === "incidents_opened" ? "incidents" : "runs"}
                dataKey={key}
                stroke={`var(--color-${key})`}
                fill={`var(--color-${key})`}
                fillOpacity={0.8}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
