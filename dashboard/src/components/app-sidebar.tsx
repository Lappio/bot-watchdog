import { useI18n } from "@/lib/i18n";
import {
  Activity,
  LayoutDashboard,
  ListTodo,
  TriangleAlert,
  Settings,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
} from "@/components/ui/sidebar";
export function AppSidebar({ path }: { path: string }) {
  const { label: translateLabel } = useI18n();
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <a href="#/">
                <Activity />
                <span className="font-semibold">bot-watchdog</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {[
              ["Overview", "/", LayoutDashboard],
              ["Tasks", "/tasks", ListTodo],
              ["Incidents", "/incidents", TriangleAlert],
              ["Settings", "/settings", Settings],
            ].map(([label, url, Icon]) => (
              <SidebarMenuItem key={String(url)}>
                <SidebarMenuButton asChild isActive={path === url}>
                  <a href={`#${url}`}>
                    <Icon />
                    <span>{translateLabel(String(label))}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
