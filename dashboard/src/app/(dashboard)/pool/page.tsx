"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { PixelCircle } from "@/components/pixel-circle";
import { Skeleton } from "@/components/ui/skeleton";

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function LegendItem({
  color,
  label,
  count,
}: {
  color: string;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-sm tracking-wide text-body">{label}</span>
      <span className="font-display text-sm font-medium text-ink">
        {formatNumber(count)}
      </span>
    </div>
  );
}

export default function PoolPage() {
  const pool = useQuery(api.dashboard.poolPixels);
  const loading = pool === undefined;

  return (
    <div className="relative min-h-full">
      <main className="relative z-10 mx-auto max-w-4xl px-6 py-10">
        <section className="flex flex-col items-center">
          <div className="aspect-square w-full max-w-xl">
            {loading ? (
              <Skeleton className="h-full w-full rounded-full" />
            ) : (
              <PixelCircle
                active={pool.active}
                restricted={pool.restricted}
                other={pool.other}
                total={pool.total}
              />
            )}
          </div>

          <div className="mt-6 flex flex-col items-center text-center">
            {loading ? (
              <Skeleton className="h-20 w-44" />
            ) : (
              <p className="font-display text-7xl font-medium tracking-tight text-ink md:text-8xl">
                {Math.round(pool.activePct)}%
              </p>
            )}
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 border-t border-hairline pt-6">
            {loading ? (
              <>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
              </>
            ) : (
              <>
                <LegendItem
                  color="var(--status-active)"
                  label="Active"
                  count={pool.active}
                />
                <LegendItem
                  color="var(--status-restricted)"
                  label="Restricted"
                  count={pool.restricted}
                />
                <LegendItem
                  color="var(--status-idle)"
                  label="Other"
                  count={pool.other}
                />
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
