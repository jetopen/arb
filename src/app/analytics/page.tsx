"use client";

import { useStats, useMessages } from "@/lib/hooks";
import { VolumeChart } from "@/components/charts/volume-chart";
import { FeeChart } from "@/components/charts/fee-chart";
import { ChainDistribution } from "@/components/charts/chain-distribution";
import { StatusBreakdown } from "@/components/charts/status-breakdown";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorState } from "@/components/ui/error-state";
import { getChainName } from "@/lib/chains";
import { useMemo } from "react";

export default function AnalyticsPage() {
  const { data: stats, error: statsError, isLoading: statsLoading } = useStats();
  const { data: messagesData, isLoading: messagesLoading } = useMessages({ take: 100 });

  const loading = statsLoading || messagesLoading;

  const chainDistribution = useMemo(() => {
    if (!messagesData?.messages) return [];
    const counts: Record<number, number> = {};
    for (const msg of messagesData.messages) {
      counts[msg.fromChainId] = (counts[msg.fromChainId] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([chainId, count]) => ({
        name: getChainName(Number(chainId)),
        value: count,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [messagesData]);

  const statusData = useMemo(() => {
    if (!messagesData?.messages) return [];
    const counts: Record<string, number> = {};
    for (const msg of messagesData.messages) {
      counts[msg.status] = (counts[msg.status] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
  }, [messagesData]);

  const volumeData = useMemo(() => {
    if (!messagesData?.messages) return [];
    const byDate: Record<string, number> = {};
    for (const msg of messagesData.messages) {
      const date = new Date(msg.timestamp * 1000).toISOString().slice(0, 10);
      byDate[date] = (byDate[date] ?? 0) + 1;
    }
    return Object.entries(byDate)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [messagesData]);

  const feeData = useMemo(() => {
    if (!messagesData?.messages) return [];
    const byDate: Record<string, number> = {};
    const byDateCount: Record<string, number> = {};
    for (const msg of messagesData.messages) {
      const date = new Date(msg.timestamp * 1000).toISOString().slice(0, 10);
      const fee = Number(msg.fee ?? 0);
      byDate[date] = (byDate[date] ?? 0) + fee;
      byDateCount[date] = (byDateCount[date] ?? 0) + 1;
    }
    return Object.entries(byDate)
      .map(([date, totalFee]) => ({
        date,
        fee: Math.round((totalFee / (byDateCount[date] ?? 1)) * 100) / 100,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [messagesData]);

  if (loading) return <LoadingSpinner />;
  if (statsError) return <ErrorState message={statsError.message} />;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Analytics</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Total Messages"
          value={stats?.totalOrders?.toLocaleString() ?? "—"}
        />
        <SummaryCard
          label="Total Volume"
          value={stats?.totalVolume ? `$${Number(stats.totalVolume).toLocaleString()}` : "—"}
        />
        <SummaryCard
          label="Total Fees"
          value={stats?.totalFees ? `$${Number(stats.totalFees).toLocaleString()}` : "—"}
        />
        <SummaryCard
          label="Active Chains"
          value={chainDistribution.length.toString()}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <VolumeChart data={volumeData} />
        <FeeChart data={feeData} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChainDistribution data={chainDistribution} />
        <StatusBreakdown data={statusData} />
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <p className="text-xs font-medium text-muted uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}
