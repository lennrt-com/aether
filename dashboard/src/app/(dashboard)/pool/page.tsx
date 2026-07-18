"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "done") return "default";
  if (status === "failed") return "destructive";
  if (status === "running") return "secondary";
  return "outline";
}

export default function SessionsPage() {
  const sessions = useQuery(api.dashboard.recentSessions);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-light tracking-tight text-ink">Sessions</h1>
        <p className="mt-1 text-sm text-muted">Recent browser and API sessions.</p>
      </div>

      <Card className="border-hairline bg-surface-card">
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
          <CardDescription>Newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {sessions === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted">No sessions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-hairline text-muted">
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Profile</th>
                    <th className="py-2 pr-4 font-medium">Channel</th>
                    <th className="py-2 pr-4 font-medium">Egress</th>
                    <th className="py-2 pr-4 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-b border-hairline/60">
                      <td className="py-3 pr-4">
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      </td>
                      <td className="py-3 pr-4">{s.profileName}</td>
                      <td className="py-3 pr-4">{s.channel}</td>
                      <td className="py-3 pr-4 font-mono text-xs">{s.egressIp ?? "—"}</td>
                      <td className="py-3 pr-4 text-muted">
                        {new Date(s.startedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
