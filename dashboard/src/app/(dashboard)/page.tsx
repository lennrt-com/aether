"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
      <CardHeader className="pb-2">
        <CardDescription className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tracking-tight text-ink">
          {value}
        </CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0">
          <p className="text-sm text-muted">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default function OverviewPage() {
  const fleet = useQuery(api.dashboard.fleetOverview);

  if (fleet === undefined) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-light tracking-tight text-ink">Overview</h1>
        <p className="mt-1 text-sm text-muted">
          Aether fleet health — agent jobs, workers, and sessions.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Jobs pending"
          value={String(fleet.jobs.pending)}
          hint={`${fleet.jobs.claimed} running · ${fleet.jobs.done} done`}
        />
        <StatCard
          label="Jobs failed"
          value={String(fleet.jobs.failed)}
          hint={`${fleet.jobs.cancelled} cancelled`}
        />
        <StatCard
          label="Workers online"
          value={String(fleet.workers.online)}
          hint={`${fleet.workers.total} registered`}
        />
        <StatCard
          label="Sessions running"
          value={String(fleet.sessions.running)}
          hint={`${fleet.proxies.active} active proxies`}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
          <CardHeader>
            <CardTitle>Webhooks</CardTitle>
            <CardDescription>Delivery status for agent job callbacks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>Delivered: {fleet.webhooks.delivered}</div>
            <div>Pending: {fleet.webhooks.pending}</div>
            <div>Retrying: {fleet.webhooks.retrying}</div>
            <div>Failed: {fleet.webhooks.failed}</div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
          <CardHeader>
            <CardTitle>Profiles</CardTitle>
            <CardDescription>Browser identity slots</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm">
            <div>Total: {fleet.profiles.total}</div>
            <div>Ephemeral: {fleet.profiles.ephemeral}</div>
            <div>Busy: {fleet.profiles.withActiveSession}</div>
            <div>Agent jobs: {fleet.jobs.total}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
