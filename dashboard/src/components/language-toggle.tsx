import { Languages } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "./ui/dropdown-menu";
export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" size="sm" aria-label={t("Choose language")}><Languages />{locale === "zh-CN" ? "中" : "EN"}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuRadioGroup value={locale} onValueChange={(value) => { if (value === "en" || value === "zh-CN") setLocale(value); }}>
        <DropdownMenuRadioItem value="en" lang="en">English</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="zh-CN" lang="zh-CN">简体中文</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
