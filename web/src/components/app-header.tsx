import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { LanguageSwitcher } from "@/components/language-switcher.tsx";
import { useCommandMenu } from "@/components/command-menu.tsx";
import { useI18n } from "@/i18n/index.tsx";

export function AppHeader() {
  const { t } = useI18n();
  const { setOpen } = useCommandMenu();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const healthy = health.data?.database === "ok" && health.data?.ffmpeg === "ok";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />

      <Button
        variant="outline"
        size="sm"
        className="hidden h-8 w-56 justify-between text-muted-foreground md:inline-flex"
        onClick={() => setOpen(true)}
      >
        <span className="inline-flex items-center gap-2">
          <Search className="size-3.5" />
          {t("Search Commands")}
        </span>
        <kbd className="pointer-events-none hidden h-5 items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium sm:inline-flex">
          ⌘K
        </kbd>
      </Button>

      <Button variant="ghost" size="icon" className="size-8 md:hidden" onClick={() => setOpen(true)}>
        <Search className="size-4" />
        <span className="sr-only">{t("Search Commands")}</span>
      </Button>

      <div className="ml-auto flex items-center gap-1.5">
        {health.data && (
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="hidden sm:inline-flex">
                <Badge variant={healthy ? "secondary" : "destructive"} className="cursor-pointer font-normal">
                  v{health.data.version}
                </Badge>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56">
              <div className="space-y-2 text-sm">
                <p className="font-medium">{healthy ? t("System Online") : t("Status Degraded")}</p>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>MongoDB</span>
                  <span className={health.data.database === "ok" ? "text-success" : "text-destructive"}>
                    {health.data.database}
                  </span>
                </div>
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>FFmpeg</span>
                  <span className={health.data.ffmpeg === "ok" ? "text-success" : "text-destructive"}>
                    {health.data.ffmpeg === "ok" ? t("Ready") : t("FFmpeg Missing")}
                  </span>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
