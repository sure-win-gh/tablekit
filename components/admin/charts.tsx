"use client";

// Admin chart primitives. recharts is only imported by files under
// app/(admin) (+ this component dir) — Turbopack per-route splitting
// keeps it out of operator bundles. Colours are design tokens only.

import { format, parseISO } from "date-fns";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type DailyPoint = { day: string; n: number };

const AXIS_TICK = { fontSize: 11, fill: "var(--color-ash)" };
const TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  border: "1px solid var(--color-hairline)",
  boxShadow: "var(--shadow-panel)",
} as const;

function dayTick(ymd: string): string {
  return format(parseISO(ymd), "d MMM");
}

// Daily-bucket bar trend. The workhorse for signups / bookings / API
// volume — deliberately minimal so several fit on one screen.
export function TrendChart({
  data,
  label,
  color = "var(--color-ink)",
  height = 160,
}: {
  data: DailyPoint[];
  label: string;
  color?: string;
  height?: number;
}) {
  if (data.length === 0) return null;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 2" vertical={false} />
          <XAxis dataKey="day" tick={AXIS_TICK} tickFormatter={dayTick} minTickGap={28} />
          <YAxis allowDecimals={false} tick={AXIS_TICK} width={30} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--color-cloud)" }}
            labelFormatter={(d) => format(parseISO(String(d)), "EEEE d MMMM")}
            formatter={(value) => [String(value), label]}
          />
          <Bar dataKey="n" name={label} fill={color} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
