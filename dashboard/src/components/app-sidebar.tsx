"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  DashboardCircleIcon,
  Logout03Icon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const navItems = [
  {
    title: "Pool",
    href: "/pool",
    icon: DashboardCircleIcon,
  },
  {
    title: "Overview",
    href: "/",
    icon: Analytics01Icon,
  },
  {
    title: "Accounts",
    href: "/accounts",
    icon: UserAccountIcon,
  },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const { signOut } = useAuthActions();

  return (
    <Sidebar className="border-r border-hairline bg-surface-card">
      <SidebarHeader className="border-b border-hairline px-4 py-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary font-display text-sm font-semibold text-on-primary">
            bG
          </span>
          <div className="min-w-0">
            <p className="text-[0.7rem] font-medium uppercase tracking-[0.12em] text-muted">
              Workspace
            </p>
            <p className="truncate font-medium tracking-tight text-ink">
              blessGTM Admin
            </p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            Main Menu
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname === item.href}
                    className="rounded-lg"
                  >
                    <Link href={item.href}>
                      <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-hairline p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="rounded-lg"
              onClick={() => void signOut()}
            >
              <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
