"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";

const poolChartConfig = {
  count: {
    label: "Accounts",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const phaseChartConfig = {
  count: {
    label: "Restrictions",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const survivalChartConfig = {
  survivalPct: {
    label: "Survival %",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

const ageChartConfig = {
  count: {
    label: "Restrictions",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

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
        <CardTitle className="font-display text-3xl font-medium tracking-tight text-ink">
          {value}
        </CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="pt-0">
          <p className="text-sm tracking-wide text-body">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
      <CardHeader className="space-y-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-20" />
      </CardHeader>
    </Card>
  );
}

function ChartCardSkeleton({ title }: { title: string }) {
  return (
    <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
      <CardHeader>
        <CardTitle className="font-display text-xl font-medium text-ink">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-64 w-full rounded-xl" />
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const poolOverview = useQuery(api.dashboard.poolOverview);
  const banRate = useQuery(api.dashboard.banRate);
  const ageAtRestriction = useQuery(api.dashboard.ageAtRestriction);
  const survivalCurve = useQuery(api.dashboard.survivalCurve);

  const loading =
    poolOverview === undefined ||
    banRate === undefined ||
    ageAtRestriction === undefined ||
    survivalCurve === undefined;

  const poolComposition = poolOverview
    ? Object.entries(poolOverview.byStatus)
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  const restrictionsByPhase = banRate
    ? Object.entries(banRate.byPhase)
        .map(([phase, count]) => ({ phase, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  return (
    <div className="relative min-h-full">
      <main className="relative z-10 mx-auto max-w-6xl px-6 py-10">
        <section className="mb-10 space-y-3">
          <Badge className="rounded-full bg-surface-strong px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink hover:bg-surface-strong">
            Tier 1 · Read-only
          </Badge>
          <h1 className="font-display text-4xl font-medium tracking-tight text-ink md:text-5xl">
            Fleet health overview
          </h1>
          <p className="max-w-2xl text-base tracking-wide text-body">
            Live pool composition, restriction rates, and survival benchmarks across
            the LinkedIn account fleet.
          </p>
        </section>

        <section className="mb-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {loading ? (
            <>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </>
          ) : (
            <>
              <StatCard label="Total accounts" value={formatNumber(poolOverview.total)} />
              <StatCard
                label="Active pool"
                value={formatNumber(poolOverview.activePool)}
                hint="Warming + active + cooldown"
              />
              <StatCard
                label="Restricted"
                value={formatNumber(poolOverview.restricted)}
                hint={`Ban rate ${formatNumber(banRate.ratePct, 1)}%`}
              />
              <StatCard label="At-risk" value={formatNumber(poolOverview.atRisk)} hint="Warning status" />
              <StatCard
                label="Avg account age"
                value={`${formatNumber(poolOverview.avgLinkedinAgeDays, 1)}d`}
                hint="Live pool average"
              />
              <StatCard
                label="Median survival"
                value={`${formatNumber(survivalCurve.medianSurvivalDays, 1)}d`}
                hint="Days until first restriction"
              />
            </>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          {loading ? (
            <>
              <ChartCardSkeleton title="Pool composition" />
              <ChartCardSkeleton title="Restrictions by phase" />
              <ChartCardSkeleton title="Survival curve" />
              <ChartCardSkeleton title="Age at restriction" />
            </>
          ) : (
            <>
              <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
                <CardHeader>
                  <CardTitle className="font-display text-xl font-medium text-ink">
                    Pool composition
                  </CardTitle>
                  <CardDescription>Accounts by lifecycle status</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={poolChartConfig} className="h-72 w-full">
                    <BarChart data={poolComposition}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="status" tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="count" fill="var(--color-count)" radius={8} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
                <CardHeader>
                  <CardTitle className="font-display text-xl font-medium text-ink">
                    Restrictions by phase
                  </CardTitle>
                  <CardDescription>
                    Lifecycle phase when restriction was detected
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={phaseChartConfig} className="h-72 w-full">
                    <BarChart data={restrictionsByPhase}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="phase" tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="count" fill="var(--color-count)" radius={8} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
                <CardHeader>
                  <CardTitle className="font-display text-xl font-medium text-ink">
                    Survival curve
                  </CardTitle>
                  <CardDescription>
                    Share of accounts not yet restricted by account age
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={survivalChartConfig} className="h-72 w-full">
                    <LineChart data={survivalCurve.points}>
                      <CartesianGrid vertical={false} />
                      <XAxis
                        dataKey="ageDays"
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `${value}d`}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(value) => `${value}%`}
                      />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line
                        type="monotone"
                        dataKey="survivalPct"
                        stroke="var(--color-survivalPct)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-hairline bg-surface-card shadow-soft">
                <CardHeader>
                  <CardTitle className="font-display text-xl font-medium text-ink">
                    Age at restriction
                  </CardTitle>
                  <CardDescription>
                    Days from LinkedIn signup to first restriction
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={ageChartConfig} className="h-72 w-full">
                    <BarChart data={ageAtRestriction.buckets}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="count" fill="var(--color-count)" radius={8} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
