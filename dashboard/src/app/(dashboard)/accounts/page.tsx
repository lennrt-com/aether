"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp01Icon,
  BanIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ALL_STATUSES = [
  "provisioning",
  "warming",
  "active",
  "cooldown",
  "warning",
  "restricted",
  "recovering",
  "retired",
] as const;

const STATUS_LABELS: Record<string, string> = {
  provisioning: "Provisioning",
  warming: "Warming",
  active: "Active",
  cooldown: "Cooldown",
  warning: "Warning",
  restricted: "Restricted",
  recovering: "Recovering",
  retired: "Retired",
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  provisioning: "bg-surface-strong text-muted hover:bg-surface-strong",
  warming: "bg-green-50 text-green-700 hover:bg-green-50",
  active: "bg-primary text-on-primary hover:bg-primary",
  cooldown: "bg-surface-strong text-ink hover:bg-surface-strong",
  warning: "bg-surface-strong text-ink ring-1 ring-hairline-strong hover:bg-surface-strong",
  restricted: "bg-destructive/10 text-destructive hover:bg-destructive/10",
  recovering: "bg-surface-strong text-body hover:bg-surface-strong",
  retired: "bg-surface-strong text-muted hover:bg-surface-strong",
};

const STATUS_ICONS = {
  warming: ArrowUp01Icon,
  restricted: BanIcon,
} as const;

function profileLinkLabel(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/in\/([^/]+)/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // fall through
  }
  return url;
}

function StatusBadge({ status }: { status: string }) {
  const icon = STATUS_ICONS[status as keyof typeof STATUS_ICONS];

  return (
    <Badge
      className={cn(
        "gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium capitalize",
        STATUS_BADGE_CLASS[status] ?? "bg-surface-strong text-body",
      )}
    >
      {icon ? (
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-3" />
      ) : null}
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function AccountsTableSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="rounded-2xl border border-hairline bg-surface-card shadow-soft">
        <div className="space-y-3 p-6">
          {Array.from({ length: 8 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

function matchesSearch(
  account: {
    name: string;
    linkedInProfileUrl: string | null;
    cohortTag: string;
  },
  query: string,
): boolean {
  if (!query) {
    return true;
  }

  const haystack = [
    account.name,
    account.cohortTag,
    account.linkedInProfileUrl ?? "",
    account.linkedInProfileUrl
      ? profileLinkLabel(account.linkedInProfileUrl)
      : "",
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function ColumnFilter({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="w-full rounded-lg border-hairline-strong bg-surface-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function AccountsPage() {
  const accounts = useQuery(api.dashboard.accounts);
  const loading = accounts === undefined;

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [selectedCohort, setSelectedCohort] = useState("all");
  const [restrictedFilter, setRestrictedFilter] = useState("all");

  const cohorts = useMemo(() => {
    if (!accounts) {
      return [];
    }
    return [...new Set(accounts.map((account) => account.cohortTag))].sort();
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    if (!accounts) {
      return [];
    }

    const query = searchQuery.trim().toLowerCase();

    return accounts.filter((account) => {
      if (selectedStatus !== "all" && account.status !== selectedStatus) {
        return false;
      }
      if (selectedCohort !== "all" && account.cohortTag !== selectedCohort) {
        return false;
      }
      if (restrictedFilter === "restricted" && !account.isRestricted) {
        return false;
      }
      if (restrictedFilter === "not_restricted" && account.isRestricted) {
        return false;
      }
      return matchesSearch(account, query);
    });
  }, [accounts, searchQuery, selectedCohort, selectedStatus, restrictedFilter]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    selectedStatus !== "all" ||
    selectedCohort !== "all" ||
    restrictedFilter !== "all";

  function clearFilters() {
    setSearchQuery("");
    setSelectedStatus("all");
    setSelectedCohort("all");
    setRestrictedFilter("all");
  }

  return (
    <div className="relative min-h-full">
      <main className="relative z-10 mx-auto max-w-6xl px-6 py-10">
        <section className="mb-8 space-y-3">
          <h1 className="font-display text-4xl font-medium tracking-tight text-ink md:text-5xl">
            Accounts
          </h1>
          <p className="max-w-2xl text-base tracking-wide text-body">
            All fleet profiles with lifecycle status and LinkedIn profile links.
          </p>
        </section>

        {loading ? (
          <AccountsTableSkeleton />
        ) : accounts.length === 0 ? (
          <div className="rounded-2xl border border-hairline bg-surface-card p-10 text-center shadow-soft">
            <p className="text-sm tracking-wide text-muted">No accounts yet.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-hairline bg-surface-card p-4 shadow-soft md:p-5">
              <div className="space-y-4">
                <div className="relative">
                  <HugeiconsIcon
                    icon={Search01Icon}
                    strokeWidth={2}
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search by name, profile, or cohort…"
                    className="h-11 rounded-lg border-hairline-strong bg-surface-card pl-10"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <ColumnFilter
                    label="Status"
                    value={selectedStatus}
                    onValueChange={setSelectedStatus}
                    options={[
                      { value: "all", label: "All statuses" },
                      ...ALL_STATUSES.map((status) => ({
                        value: status,
                        label: STATUS_LABELS[status] ?? status,
                      })),
                    ]}
                  />
                  <ColumnFilter
                    label="Cohort"
                    value={selectedCohort}
                    onValueChange={setSelectedCohort}
                    options={[
                      { value: "all", label: "All cohorts" },
                      ...cohorts.map((cohort) => ({
                        value: cohort,
                        label: cohort,
                      })),
                    ]}
                  />
                  <ColumnFilter
                    label="Restricted"
                    value={restrictedFilter}
                    onValueChange={setRestrictedFilter}
                    options={[
                      { value: "all", label: "All accounts" },
                      { value: "restricted", label: "Restricted only" },
                      { value: "not_restricted", label: "Not restricted" },
                    ]}
                  />
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    {hasActiveFilters ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="rounded-full"
                        onClick={clearFilters}
                      >
                        Clear filters
                      </Button>
                    ) : null}
                  </div>

                  <p className="text-sm tracking-wide text-muted">
                    Showing {filteredAccounts.length} of {accounts.length}
                  </p>
                </div>
              </div>
            </div>

            {filteredAccounts.length === 0 ? (
              <div className="rounded-2xl border border-hairline bg-surface-card p-10 text-center shadow-soft">
                <p className="text-sm tracking-wide text-muted">
                  No accounts match your filters.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-hairline bg-surface-card shadow-soft">
                <Table>
                  <TableHeader>
                    <TableRow className="border-hairline hover:bg-transparent">
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Name
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Status
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Profile
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Age
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Risk
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                        Cohort
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAccounts.map((account) => (
                      <TableRow key={account.id} className="border-hairline">
                        <TableCell className="font-medium text-ink">
                          {account.name}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={account.status} />
                        </TableCell>
                        <TableCell>
                          {account.linkedInProfileUrl ? (
                            <a
                              href={account.linkedInProfileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-ink underline-offset-4 hover:underline"
                            >
                              {profileLinkLabel(account.linkedInProfileUrl)}
                            </a>
                          ) : (
                            <span className="text-sm text-muted">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-body">
                          {account.linkedinAgeDays !== null
                            ? `${account.linkedinAgeDays.toFixed(1)}d`
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-body">
                          {account.riskScore}
                        </TableCell>
                        <TableCell className="text-sm text-body">
                          {account.cohortTag}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
