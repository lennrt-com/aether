import { DashboardShell } from "@/components/dashboard-shell";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <DashboardShell>{children}</DashboardShell>
    </TooltipProvider>
  );
}
