"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface DataPoint {
  status: string;
  count: number;
}

interface StatusBreakdownProps {
  data: DataPoint[];
}

const STATUS_COLORS: Record<string, string> = {
  Executed: "#10b981",
  "Awaiting Confirmation": "#f59e0b",
  "Awaiting Execution": "#f59e0b",
  Executing: "#3b82f6",
  Cancelled: "#9ca3af",
  Failed: "#ef4444",
};

export function StatusBreakdown({ data }: StatusBreakdownProps) {
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <h3 className="text-sm font-medium text-muted mb-4">Status Distribution</h3>
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis type="number" tick={{ fontSize: 12 }} stroke="#9ca3af" />
          <YAxis
            type="category"
            dataKey="status"
            tick={{ fontSize: 12 }}
            stroke="#9ca3af"
            width={120}
          />
          <Tooltip />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={STATUS_COLORS[entry.status] ?? "#6b7280"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
