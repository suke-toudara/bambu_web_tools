import type { Loop, Vec2 } from "./types";

export function signedArea(loop: Loop): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

/** Left-hand normal of a direction vector (rotate +90deg). For loops produced
 * by the mesh slicer, "left of travel direction" is always the solid
 * material side, for both outer (CCW) and hole (CW) loops. */
function leftNormal(d: Vec2): Vec2 {
  return { x: -d.y, y: d.x };
}

/**
 * Insets a closed loop toward its material side by `distance` using a simple
 * per-vertex miter offset. This is a pragmatic approximation (no proper
 * clipping of self-intersections on sharp concave corners) but works well
 * for typical printable geometry.
 */
export function insetLoop(loop: Loop, distance: number): Loop | null {
  const n = loop.length;
  if (n < 3) return null;
  const result: Vec2[] = [];
  const MIN_COS = 0.2; // clamps miter length to at most distance / MIN_COS

  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];

    const d1 = normalize({ x: cur.x - prev.x, y: cur.y - prev.y });
    const d2 = normalize({ x: next.x - cur.x, y: next.y - cur.y });
    const n1 = leftNormal(d1);
    const n2 = leftNormal(d2);

    let bisector = { x: n1.x + n2.x, y: n1.y + n2.y };
    const bisLen = Math.hypot(bisector.x, bisector.y);
    if (bisLen < 1e-9) {
      // ~180 degree fold; fall back to n1 direction.
      bisector = n1;
    } else {
      bisector = { x: bisector.x / bisLen, y: bisector.y / bisLen };
    }

    const cosHalf = Math.max(bisector.x * n1.x + bisector.y * n1.y, MIN_COS);
    const scale = distance / cosHalf;

    result.push({ x: cur.x + bisector.x * scale, y: cur.y + bisector.y * scale });
  }

  // Degenerate/self-collapsed loop guard: if the resulting polygon's area
  // flips sign and becomes tiny/inverted relative to source, drop it.
  const srcArea = Math.abs(signedArea(loop));
  const newArea = Math.abs(signedArea(result));
  if (newArea < 1e-6 || newArea > srcArea * 4) return null;

  return result;
}

/** Rotates a point around the origin by `angleRad`. */
export function rotatePoint(p: Vec2, angleRad: number): Vec2 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/**
 * Scanline fill: given a set of loops (outer + holes, even-odd rule) and a
 * fill angle, returns fill line segments (in original coordinate space)
 * spaced `spacing` apart.
 */
export function scanlineFill(loops: Loop[], spacing: number, angleRad: number): [Vec2, Vec2][] {
  if (loops.length === 0 || spacing <= 0) return [];

  const rotated = loops.map((loop) => loop.map((p) => rotatePoint(p, -angleRad)));

  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const loop of rotated) {
    for (const p of loop) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
  }
  if (!isFinite(minY)) return [];

  const segments: [Vec2, Vec2][] = [];
  const startY = Math.ceil(minY / spacing) * spacing;

  for (let y = startY; y <= maxY; y += spacing) {
    const xs: number[] = [];
    for (const loop of rotated) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const p1 = loop[i];
        const p2 = loop[(i + 1) % n];
        if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
          const t = (y - p1.y) / (p2.y - p1.y);
          xs.push(p1.x + t * (p2.x - p1.x));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const p1 = rotatePoint({ x: xs[i], y }, angleRad);
      const p2 = rotatePoint({ x: xs[i + 1], y }, angleRad);
      segments.push([p1, p2]);
    }
  }

  return segments;
}

/** Bounding box helper used by the caller for line spacing/coverage. */
export function loopBounds(loops: Loop[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}
