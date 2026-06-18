"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const SECTION_LABELS: Record<string, string> = {
  "/": "Overview",
  "/pool": "Pool",
  "/accounts": "Accounts",
};

function sectionLabel(pathname: string): string {
  if (SECTION_LABELS[pathname]) {
    return SECTION_LABELS[pathname];
  }
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) {
    return "Overview";
  }
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const section = sectionLabel(pathname);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-h-svh bg-canvas">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-hairline bg-canvas/80 px-4 backdrop-blur md:px-6">
          <SidebarTrigger className="rounded-lg border border-hairline bg-surface-card text-body shadow-soft" />
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-sm tracking-wide"
          >
            <span className="text-muted">Dashboard</span>
            <span className="text-hairline-strong">/</span>
            <span className="font-medium text-ink">{section}</span>
          </nav>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
