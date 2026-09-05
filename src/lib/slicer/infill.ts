import type { InfillPattern, Loop, Vec2 } from "./types";
import { insetLoop, loopBounds, scanlineFill } from "./polygon";

export const INFILL_PATTERNS: { id: InfillPattern; label: string; description: string }[] = [
  {
    id: "lines",
    label: "ライン (直線)",
    description: "1層ごとに45°/135°で交差する直線。最速で最も材料が少なく済みます。",
  },
  {
    id: "grid",
    label: "グリッド (格子)",
    description: "同じ層に直交2方向。ラインより強く、汎用の既定値として扱いやすい形状です。",
  },
  {
    id: "triangles",
    label: "トライアングル (三角)",
    description: "同じ層に3方向。面内のどの向きにも強く、横荷重に強い構造です。",
  },
  {
    id: "cubic",
    label: "キュービック (立体格子)",
    description: "層ごとに向きが回る格子。上下方向を含めて偏りが少なくなります。",
  },
  {
    id: "concentric",
    label: "コンセントリック (同心)",
    description: "輪郭を内側へ繰り返す形状。柔軟材(TPU)や、外形に沿わせたい場合に向きます。",
  },
  {
    id: "honeycomb",
    label: "ハニカム (六角)",
    description:
      "六角セル。単位重量あたりの強度が高い一方、経路が細かく分かれるためリトラクションが増え、印刷時間は長めになります。",
  },
  {
    id: "gyroid",
    label: "ジャイロイド",
    description:
      "層ごとに連続的に変化する曲線。全方向にほぼ均等な強度が得られます。ただし経路が短い曲線の集まりになるため、この簡易スライサーではリトラクションが多く、印刷時間も長くなります。",
  },
];

export function getInfillPattern(id: InfillPattern) {
  return INFILL_PATTERNS.find((p) => p.id === id) ?? INFILL_PATTERNS[0];
}

/** Even-odd point-in-polygon test across a set of loops (outer + holes). */
function pointInLoops(p: Vec2, loops: Loop[]): boolean {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      if (a.y > p.y !== b.y > p.y) {
        const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x > p.x) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Trims arbitrary line segments down to the parts that fall inside `loops`.
 *
 * `scanlineFill` can only produce straight, axis-aligned-after-rotation
 * lines, which is why every infill so far had to be a set of parallel
 * lines. This clips *any* segment soup — a hex grid, a marching-squares
 * gyroid contour — against the layer boundary, so the pattern generators
 * below can just emit their geometry over the bounding box and let this cut
 * it to shape.
 */
export function clipSegmentsToLoops(segments: [Vec2, Vec2][], loops: Loop[]): [Vec2, Vec2][] {
  if (loops.length === 0) return [];
  const out: [Vec2, Vec2][] = [];

  for (const [a, b] of segments) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) continue;

    const ts: number[] = [0, 1];
    for (const loop of loops) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const p = loop[i];
        const q = loop[(i + 1) % n];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-12) continue;
        const t = ((p.x - a.x) * ey - (p.y - a.y) * ex) / denom;
        const u = ((p.x - a.x) * dy - (p.y - a.y) * dx) / denom;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }

    ts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      if (!pointInLoops({ x: a.x + dx * tm, y: a.y + dy * tm }, loops)) continue;
      out.push([
        { x: a.x + dx * t0, y: a.y + dy * t0 },
        { x: a.x + dx * t1, y: a.y + dy * t1 },
      ]);
    }
  }

  return out;
}

/**
 * Reorders segments so that ones sharing an endpoint come out consecutively,
 * head-to-tail.
 *
 * Marching squares and the hex grid emit their geometry cell by cell, so a
 * single continuous gyroid curve arrives as hundreds of disconnected
 * two-point segments in arbitrary order. Printed in that order, every one of
 * them costs a retract + travel + unretract — enormously slow and stringy.
 * Chaining them lets the gcode writer extrude straight through a run.
 */
export function chainSegments(segments: [Vec2, Vec2][], tolerance = 1e-3): [Vec2, Vec2][] {
  if (segments.length < 2) return segments;

  const q = 1 / tolerance;
  const key = (p: Vec2) => `${Math.round(p.x * q)},${Math.round(p.y * q)}`;

  // endpoint -> indices of segments touching it
  const touching = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const arr = touching.get(k);
    if (arr) arr.push(i);
    else touching.set(k, [i]);
  };
  segments.forEach((s, i) => {
    add(key(s[0]), i);
    add(key(s[1]), i);
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const out: [Vec2, Vec2][] = [];

  const nextFrom = (k: string): number => {
    const candidates = touching.get(k);
    if (!candidates) return -1;
    for (const i of candidates) if (!used[i]) return i;
    return -1;
  };

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    out.push(segments[start]);

    // Walk forward from the run's current end for as long as it continues.
    let end = segments[start][1];
    for (;;) {
      const i = nextFrom(key(end));
      if (i < 0) break;
      used[i] = true;
      // Orient the segment so it continues from `end`.
      const seg = segments[i];
      const forward = key(seg[0]) === key(end);
      const oriented: [Vec2, Vec2] = forward ? seg : [seg[1], seg[0]];
      out.push(oriented);
      end = oriented[1];
    }
  }

  return out;
}

/** Concentric rings: repeatedly inset the boundary itself. */
function concentricInfill(boundary: Loop[], spacing: number): [Vec2, Vec2][] {
  const segments: [Vec2, Vec2][] = [];
  const MAX_RINGS = 200;

  for (const loop of boundary) {
    let current: Loop | null = loop;
    for (let ring = 0; ring < MAX_RINGS && current; ring++) {
      for (let i = 0; i < current.length; i++) {
        segments.push([current[i], current[(i + 1) % current.length]]);
      }
      current = insetLoop(current, spacing);
    }
  }
  return segments;
}

/** Flat-top hexagons on a staggered grid, de-duplicated so shared walls are
 * only extruded once. */
function honeycombSegments(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cellRadius: number
): [Vec2, Vec2][] {
  const segments: [Vec2, Vec2][] = [];
  const seen = new Set<string>();
  const colStep = cellRadius * 1.5;
  const rowStep = cellRadius * Math.sqrt(3);

  const colStart = Math.floor((bounds.minX - cellRadius * 2) / colStep);
  const colEnd = Math.ceil((bounds.maxX + cellRadius * 2) / colStep);
  const rowStart = Math.floor((bounds.minY - cellRadius * 2) / rowStep);
  const rowEnd = Math.ceil((bounds.maxY + cellRadius * 2) / rowStep);

  const round = (v: number) => Math.round(v * 1000) / 1000;

  for (let col = colStart; col <= colEnd; col++) {
    for (let row = rowStart; row <= rowEnd; row++) {
      const cx = col * colStep;
      const cy = row * rowStep + (col % 2 === 0 ? 0 : rowStep / 2);
      for (let k = 0; k < 6; k++) {
        const a0 = (k * Math.PI) / 3;
        const a1 = ((k + 1) * Math.PI) / 3;
        const p = { x: cx + cellRadius * Math.cos(a0), y: cy + cellRadius * Math.sin(a0) };
        const q = { x: cx + cellRadius * Math.cos(a1), y: cy + cellRadius * Math.sin(a1) };
        // Shared edges appear twice (once per adjacent hexagon); key them
        // order-independently so each wall is only printed once.
        const ka = `${round(p.x)},${round(p.y)}`;
        const kb = `${round(q.x)},${round(q.y)}`;
        const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        segments.push([p, q]);
      }
    }
  }
  return segments;
}

/**
 * Gyroid contour for this Z, via marching squares over the implicit surface
 *   sin x·cos y + sin y·cos z + sin z·cos x = 0
 * Because z enters the field directly, the pattern shifts continuously from
 * layer to layer — that is what makes a gyroid isotropic rather than a stack
 * of identical 2D patterns.
 */
function gyroidSegments(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  periodMm: number,
  z: number
): [Vec2, Vec2][] {
  const k = (2 * Math.PI) / periodMm;
  const step = periodMm / 8; // resolution of the marching-squares grid
  const sinKz = Math.sin(z * k);
  const cosKz = Math.cos(z * k);
  const field = (x: number, y: number) =>
    Math.sin(x * k) * Math.cos(y * k) + Math.sin(y * k) * cosKz + sinKz * Math.cos(x * k);

  const segments: [Vec2, Vec2][] = [];
  const nx = Math.ceil((bounds.maxX - bounds.minX) / step) + 1;
  const ny = Math.ceil((bounds.maxY - bounds.minY) / step) + 1;
  if (nx < 2 || ny < 2 || nx * ny > 4_000_000) return segments;

  // Evaluate the field once per grid point rather than four times per cell.
  const values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = bounds.minY + j * step;
    for (let i = 0; i < nx; i++) {
      values[j * nx + i] = field(bounds.minX + i * step, y);
    }
  }

  const interp = (p: Vec2, q: Vec2, fp: number, fq: number): Vec2 => {
    const t = Math.abs(fq - fp) < 1e-12 ? 0.5 : fp / (fp - fq);
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };

  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const x0 = bounds.minX + i * step;
      const y0 = bounds.minY + j * step;
      const x1 = x0 + step;
      const y1 = y0 + step;

      const f00 = values[j * nx + i];
      const f10 = values[j * nx + i + 1];
      const f11 = values[(j + 1) * nx + i + 1];
      const f01 = values[(j + 1) * nx + i];

      const corners: [Vec2, number][] = [
        [{ x: x0, y: y0 }, f00],
        [{ x: x1, y: y0 }, f10],
        [{ x: x1, y: y1 }, f11],
        [{ x: x0, y: y1 }, f01],
      ];

      // Collect zero crossings along the four cell edges.
      const crossings: Vec2[] = [];
      for (let e = 0; e < 4; e++) {
        const [p, fp] = corners[e];
        const [q, fq] = corners[(e + 1) % 4];
        if (fp > 0 !== fq > 0) crossings.push(interp(p, q, fp, fq));
      }

      if (crossings.length === 2) {
        segments.push([crossings[0], crossings[1]]);
      } else if (crossings.length === 4) {
        // Saddle cell: which two pairs of crossings actually connect is
        // ambiguous from the corners alone, and guessing wrong breaks the
        // contour into pieces that no longer chain with their neighbours.
        // The sign at the cell centre resolves it.
        if (field(x0 + step / 2, y0 + step / 2) > 0) {
          segments.push([crossings[0], crossings[1]]);
          segments.push([crossings[2], crossings[3]]);
        } else {
          segments.push([crossings[1], crossings[2]]);
          segments.push([crossings[3], crossings[0]]);
        }
      }
    }
  }

  return segments;
}

/**
 * Builds the sparse infill for one layer.
 *
 * `spacing` is derived so that every pattern lays down roughly the same
 * amount of material for a given density: a pattern that draws lines in N
 * directions gets its spacing multiplied by N.
 */
export function generateInfill(
  boundary: Loop[],
  pattern: InfillPattern,
  densityPct: number,
  extrusionWidthMm: number,
  layerIndex: number,
  z: number
): [Vec2, Vec2][] {
  if (boundary.length === 0 || densityPct <= 0) return [];

  const baseSpacing = extrusionWidthMm / (densityPct / 100);
  const deg = (d: number) => (d * Math.PI) / 180;

  switch (pattern) {
    case "lines": {
      // Alternating 45/135 keeps successive layers from stacking into walls.
      return scanlineFill(boundary, baseSpacing, deg(layerIndex % 2 === 0 ? 45 : 135));
    }

    case "grid": {
      const spacing = baseSpacing * 2;
      return [
        ...scanlineFill(boundary, spacing, deg(45)),
        ...scanlineFill(boundary, spacing, deg(135)),
      ];
    }

    case "triangles": {
      const spacing = baseSpacing * 3;
      return [
        ...scanlineFill(boundary, spacing, deg(0)),
        ...scanlineFill(boundary, spacing, deg(60)),
        ...scanlineFill(boundary, spacing, deg(120)),
      ];
    }

    case "cubic": {
      // A grid whose orientation advances every layer, approximating a
      // rotated cubic lattice rather than a flat one.
      const spacing = baseSpacing * 2;
      const twist = (layerIndex % 3) * 30;
      return [
        ...scanlineFill(boundary, spacing, deg(45 + twist)),
        ...scanlineFill(boundary, spacing, deg(135 + twist)),
      ];
    }

    case "concentric": {
      return chainSegments(clipSegmentsToLoops(concentricInfill(boundary, baseSpacing), boundary));
    }

    case "honeycomb": {
      const bounds = loopBounds(boundary);
      if (!bounds) return [];
      // Hex wall length per unit area scales with 1/radius; this keeps the
      // material use close to the equivalent line infill.
      const radius = Math.max(baseSpacing * 0.9, extrusionWidthMm * 1.5);
      return chainSegments(clipSegmentsToLoops(honeycombSegments(bounds, radius), boundary));
    }

    case "gyroid": {
      const bounds = loopBounds(boundary);
      if (!bounds) return [];
      const period = Math.max(baseSpacing * 2, extrusionWidthMm * 4);
      return chainSegments(clipSegmentsToLoops(gyroidSegments(bounds, period, z), boundary));
    }

    default:
      return scanlineFill(boundary, baseSpacing, deg(layerIndex % 2 === 0 ? 45 : 135));
  }
}
