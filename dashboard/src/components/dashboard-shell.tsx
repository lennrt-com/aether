"use client";

import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-h-svh bg-canvas">
        <div className="fixed left-4 top-4 z-30 md:hidden">
          <SidebarTrigger className="rounded-full border border-hairline bg-surface-card shadow-soft" />
        </div>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
