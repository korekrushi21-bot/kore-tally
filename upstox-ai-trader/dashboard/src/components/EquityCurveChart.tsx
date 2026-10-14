interface Point {
  date: string;
  equity: number;
}

export function EquityCurveChart({ points }: { points: Point[] }) {
  if (points.length < 2) return <p className="muted">Not enough data points to draw an equity curve.</p>;

  const width = 640;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 24, left: 56 };

  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const x = (i: number) => padding.left + (i / (points.length - 1)) * innerWidth;
  const y = (v: number) => padding.top + innerHeight - ((v - min) / range) * innerHeight;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
  const startEquity = points[0].equity;
  const endEquity = points[points.length - 1].equity;
  const lineColor = endEquity >= startEquity ? "var(--green)" : "var(--red)";
  const startY = y(startEquity);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto" }}>
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={startY}
        y2={startY}
        stroke="var(--border)"
        strokeDasharray="4 4"
      />
      <text x={4} y={padding.top + 4} fontSize="10" fill="var(--text-muted)">
        {max.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
      </text>
      <text x={4} y={height - padding.bottom} fontSize="10" fill="var(--text-muted)">
        {min.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
      </text>
      <path d={linePath} fill="none" stroke={lineColor} strokeWidth={2} />
      <text x={padding.left} y={height - 6} fontSize="10" fill="var(--text-muted)">
        {new Date(points[0].date).toLocaleDateString()}
      </text>
      <text x={width - padding.right} y={height - 6} fontSize="10" fill="var(--text-muted)" textAnchor="end">
        {new Date(points[points.length - 1].date).toLocaleDateString()}
      </text>
    </svg>
  );
}
