"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
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
      <SidebarHeader className="border-b border-hairline px-4 py-5">
        <div className="space-y-1">
          <p className="font-medium tracking-tight text-ink">blessGTM Admin</p>
          <p className="text-xs tracking-wide text-muted">
            Pool health & survival
          </p>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
            Monitoring
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
