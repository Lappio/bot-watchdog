import { useI18n } from "@/lib/i18n";
import { cn } from "cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  const { t } = useI18n();
  return (
    <div
      data-slot="skeleton"
      role="status"
      aria-label={t("Loading…")}
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
