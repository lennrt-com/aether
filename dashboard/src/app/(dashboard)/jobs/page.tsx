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
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "claimed") return "secondary";
  return "outline";
}

export default function JobsPage() {
  const jobs = useQuery(api.jobs.listRecent, { limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-light tracking-tight text-ink">Jobs</h1>
        <p className="mt-1 text-sm text-muted">Recent agent runs submitted via the HTTP API.</p>
      </div>

      <Card className="border-hairline bg-surface-card">
        <CardHeader>
          <CardTitle>Agent queue</CardTitle>
          <CardDescription>Status, model, webhook delivery, and errors.</CardDescription>
        </CardHeader>
        <CardContent>
          {jobs === undefined ? (
            <Skeleton className="h-40 w-full" />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted">No agent jobs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-hairline text-muted">
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Start URL</th>
                    <th className="py-2 pr-4 font-medium">Model</th>
                    <th className="py-2 pr-4 font-medium">Webhook</th>
                    <th className="py-2 pr-4 font-medium">Job ID</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} className="border-b border-hairline/60">
                      <td className="py-3 pr-4">
                        <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
                      </td>
                      <td className="max-w-xs truncate py-3 pr-4">{job.startUrl ?? "—"}</td>
                      <td className="py-3 pr-4">{job.model ?? "—"}</td>
                      <td className="py-3 pr-4">{job.webhookStatus ?? "—"}</td>
                      <td className="py-3 pr-4 font-mono text-xs text-muted">{job.id}</td>
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
