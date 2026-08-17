import { Loader2 } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { PageHeader } from "@/components/page-header.tsx";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/i18n/index.tsx";
import { SettingsDraftProvider, useSettingsDraft } from "./context.tsx";
import { SETTINGS_SECTIONS } from "./nav.ts";

function SettingsChrome() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const { draft, save, saving } = useSettingsDraft();
  const section = SETTINGS_SECTIONS.find((entry) => pathname === entry.path) ?? SETTINGS_SECTIONS[0];
  const fill = pathname === "/settings/narration";
  const header = (
    <PageHeader
      title={t(section.titleKey)}
      description={t(section.descriptionKey)}
      actions={
        <Button disabled={!draft || saving} onClick={save}>
          {saving && <Loader2 className="animate-spin" />}
          {t("Save")}
        </Button>
      }
    />
  );
  const body = draft ? (
    <Outlet />
  ) : (
    <div className="space-y-3">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );

  return (
    <SidebarProvider
      className="h-full min-h-0 flex-1 overflow-hidden"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      <Sidebar collapsible="none" className="hidden border-r bg-sidebar md:flex">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{t("Settings")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {SETTINGS_SECTIONS.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild isActive={pathname === item.path} tooltip={t(item.titleKey)}>
                      <NavLink to={item.path}>
                        <span className={`flex size-6 shrink-0 items-center justify-center rounded-md ${item.iconClass}`}>
                          <item.icon className="size-3.5" />
                        </span>
                        <span>{t(item.titleKey)}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <nav className="flex gap-1 overflow-x-auto border-b p-2 md:hidden">
          {SETTINGS_SECTIONS.map((item) => (
            <Button key={item.id} variant={pathname === item.path ? "secondary" : "ghost"} size="sm" asChild>
              <NavLink to={item.path}>
                <span className={`flex size-5 shrink-0 items-center justify-center rounded-md ${item.iconClass}`}>
                  <item.icon className="size-3" />
                </span>
                {t(item.titleKey)}
              </NavLink>
            </Button>
          ))}
        </nav>

        {fill ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6">
            {header}
            {body}
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
              {header}
              {body}
            </div>
          </ScrollArea>
        )}
      </div>
    </SidebarProvider>
  );
}

export function SettingsLayout() {
  return (
    <SettingsDraftProvider>
      <SettingsChrome />
    </SettingsDraftProvider>
  );
}
