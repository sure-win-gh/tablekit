"use client";

import { Line, LineChart, ResponsiveContainer } from "recharts";

// Tiny line chart for the admin overview KPI tiles. No axes, no
// tooltip, no animation — pure decoration so the shape of the trend
// is visible without needing the reader to mouse over.
//
// recharts is only imported by files under app/(admin)/ — Turbopack
// per-route splitting keeps it out of operator bundles.
//
// Defaults sized to fit beneath a Stat tile (full-width × 28px).

export function Sparkline({
  data,
  color = "var(--color-ink)",
  height = 28,
  strokeWidth = 1.5,
}: {
  data: { day: string; n: number }[];
  color?: string;
  height?: number;
  strokeWidth?: number;
}) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <Line
          type="monotone"
          dataKey="n"
          stroke={color}
          strokeWidth={strokeWidth}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
