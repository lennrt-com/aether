"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const VIEWBOX = 100;
const CENTER = VIEWBOX / 2;
const RADIUS = 46;
const CELL = 2;
const MAX_DOTS = 1500;
const BORDER_COLOR = "var(--status-border)";
const TRAIL_LENGTH = 12;
const ANIMATION_MS = 1400;
const ACTIVE_TRAIL_COLOR = "var(--status-active)";
const RESTRICTED_TRAIL_COLOR = "#000000";

const COLORS = [
  "var(--status-active)",
  "var(--status-restricted)",
  "var(--status-idle)",
] as const;

type AnimationKind = "active" | "restricted";

type PixelCircleProps = {
  active: number;
  restricted: number;
  other: number;
  total: number;
  className?: string;
};

type GridCell = { cx: number; cy: number; sideIndex: number };

function bucketDots(
  active: number,
  restricted: number,
  other: number,
  total: number,
  n: number,
): [number, number, number] {
  if (total === 0 || n === 0) {
    return [0, 0, 0];
  }
  const raw = [active, restricted, other].map((c) => (c / total) * n);
  const counts = raw.map(Math.floor);
  let remainder = n - counts.reduce((sum, c) => sum + c, 0);
  const byFraction = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (remainder > 0) {
    counts[byFraction[k % 3].index] += 1;
    remainder -= 1;
    k += 1;
  }
  return [counts[0], counts[1], counts[2]];
}

function layeredColorIndices(counts: [number, number, number]): number[] {
  const [activeCount, restrictedCount, otherCount] = counts;
  return [
    ...Array<number>(activeCount).fill(0),
    ...Array<number>(restrictedCount).fill(1),
    ...Array<number>(otherCount).fill(2),
  ];
}

function buildGrid(): {
  borderLeft: GridCell[];
  borderRight: GridCell[];
  data: GridCell[];
} {
  const span = RADIUS * 2;
  const count = Math.floor(span / CELL);
  const origin = CENTER - (count * CELL) / 2;
  const innerRadius = RADIUS - CELL;

  const borderLeft: Omit<GridCell, "sideIndex">[] = [];
  const borderRight: Omit<GridCell, "sideIndex">[] = [];
  const data: GridCell[] = [];

  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      const cx = origin + col * CELL + CELL / 2;
      const cy = origin + row * CELL + CELL / 2;
      const dist = Math.hypot(cx - CENTER, cy - CENTER);
      if (dist > RADIUS) {
        continue;
      }
      if (dist > innerRadius) {
        if (cx < CENTER) {
          borderLeft.push({ cx, cy });
        } else {
          borderRight.push({ cx, cy });
        }
      } else {
        data.push({ cx, cy, sideIndex: 0 });
      }
    }
  }

  borderLeft.sort((a, b) => b.cy - a.cy || a.cx - b.cx);
  borderRight.sort((a, b) => b.cy - a.cy || a.cx - b.cx);

  return {
    borderLeft: borderLeft.map((cell, sideIndex) => ({ ...cell, sideIndex })),
    borderRight: borderRight.map((cell, sideIndex) => ({ ...cell, sideIndex })),
    data: data.sort((a, b) => b.cy - a.cy || a.cx - b.cx),
  };
}

const GRID = buildGrid();

function borderPixelStyle(
  sideIndex: number,
  sideLength: number,
  progress: number,
  kind: AnimationKind,
): { fill: string; opacity: number } {
  const headPosition = progress * (sideLength + TRAIL_LENGTH);
  const trailDistance = headPosition - sideIndex;
  if (trailDistance >= 0 && trailDistance < TRAIL_LENGTH) {
    const fade = 1 - trailDistance / TRAIL_LENGTH;
    return {
      fill: kind === "active" ? ACTIVE_TRAIL_COLOR : RESTRICTED_TRAIL_COLOR,
      opacity: 0.25 + fade * 0.75,
    };
  }
  return { fill: BORDER_COLOR, opacity: 1 };
}

function Pixel({
  cx,
  cy,
  fill,
  opacity = 1,
}: {
  cx: number;
  cy: number;
  fill: string;
  opacity?: number;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={CELL / 2}
      fill={fill}
      opacity={opacity}
    />
  );
}

export function PixelCircle({
  active,
  restricted,
  other,
  total,
  className,
}: PixelCircleProps) {
  const { borderLeft, borderRight, data } = GRID;
  const n = Math.min(total, MAX_DOTS, data.length);

  const [animKind, setAnimKind] = useState<AnimationKind | null>(null);
  const [animProgress, setAnimProgress] = useState(0);
  const prevCountsRef = useRef<{ active: number; restricted: number } | null>(
    null,
  );

  const maxSideLength = useMemo(
    () => Math.max(borderLeft.length, borderRight.length, 1),
    [borderLeft.length, borderRight.length],
  );

  useEffect(() => {
    const prev = prevCountsRef.current;
    prevCountsRef.current = { active, restricted };

    if (prev === null) {
      return;
    }

    let kind: AnimationKind | null = null;
    if (active > prev.active) {
      kind = "active";
    } else if (restricted > prev.restricted) {
      kind = "restricted";
    }
    if (!kind) {
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    setAnimKind(kind);
    setAnimProgress(0);

    const start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / ANIMATION_MS);
      setAnimProgress(progress);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setAnimKind(null);
        setAnimProgress(0);
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, restricted]);

  const renderBorderSide = (cells: GridCell[], sideLength: number) =>
    cells.map((cell) => {
      const style =
        animKind === null
          ? { fill: BORDER_COLOR, opacity: 1 }
          : borderPixelStyle(
              cell.sideIndex,
              sideLength,
              animProgress,
              animKind,
            );
      return (
        <Pixel
          key={`${cell.cx}-${cell.cy}`}
          cx={cell.cx}
          cy={cell.cy}
          fill={style.fill}
          opacity={style.opacity}
        />
      );
    });

  if (n === 0) {
    return (
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        className={cn("h-full w-full", className)}
        role="img"
        aria-label="No accounts in the pool yet"
      >
        {renderBorderSide(borderLeft, maxSideLength)}
        {renderBorderSide(borderRight, maxSideLength)}
      </svg>
    );
  }

  const counts = bucketDots(active, restricted, other, total, n);
  const colorIndices = layeredColorIndices(counts);
  const dataPixels = data.slice(0, n).map((cell, i) => ({
    ...cell,
    fill: COLORS[colorIndices[i]!],
  }));

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className={cn("h-full w-full", className)}
      role="img"
      aria-label={`${active} active, ${restricted} restricted, ${other} other of ${total} accounts`}
    >
      {dataPixels.map((pixel, i) => (
        <Pixel key={`d-${i}`} cx={pixel.cx} cy={pixel.cy} fill={pixel.fill} />
      ))}
      {renderBorderSide(borderLeft, maxSideLength)}
      {renderBorderSide(borderRight, maxSideLength)}
    </svg>
  );
}
