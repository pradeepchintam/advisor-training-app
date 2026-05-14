import React from 'react';

interface ScoreGaugeProps {
  score: number; // 1-10
  size?: number;
  strokeWidth?: number;
  showLabel?: boolean;
}

function getColor(score: number): string {
  if (score >= 8) return '#22c55e'; // green
  if (score >= 5) return '#f59e0b'; // amber/gold
  return '#ef4444'; // red
}

export default function ScoreGauge({
  score,
  size = 120,
  strokeWidth = 10,
  showLabel = true,
}: ScoreGaugeProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // We use 270° arc (from 135° to 405°, starting bottom-left to bottom-right)
  const arcLength = circumference * 0.75;
  const offset = arcLength - (score / 10) * arcLength;

  const color = getColor(score);
  const cx = size / 2;
  const cy = size / 2;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(135deg)' }}>
        {/* Background track */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="#334155"
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength} ${circumference}`}
          strokeLinecap="round"
        />
        {/* Value arc */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${arcLength - offset} ${circumference}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
      </svg>
      {showLabel && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-bold leading-none" style={{ fontSize: size * 0.22, color }}>
            {score.toFixed(1)}
          </span>
          <span className="text-slate-500 leading-none" style={{ fontSize: size * 0.1 }}>
            / 10
          </span>
        </div>
      )}
    </div>
  );
}
