import type { Loop, SliceSettings, SliceResult, Triangle, Vec2, Vec3 } from "./types";
import { insetLoop, scanlineFill } from "./polygon";

function key(p: Vec2, precision = 10000): string {
  return `${Math.round(p.x * precision)}_${Math.round(p.y * precision)}`;
}

/** Intersects a single triangle with a horizontal plane at `planeZ`.
 * Returns a directed segment [p1, p2] if the plane crosses the triangle, or
 * null otherwise. Orientation: walking the triangle's edges in winding
 * order, the first crossing point connects to the second; this yields
 * segments where the solid material is consistently to the left of travel
 * direction once segments are chained into loops (assuming outward-facing,
 * consistently wound mesh triangles). */
export function intersectTriangle(tri: Triangle, planeZ: number): [Vec2, Vec2] | null {
  const verts = [tri.a, tri.b, tri.c];
  const side = (v: Vec3) => (v.z >= planeZ ? 1 : -1);
  const sides = verts.map(side);

  // Walking the triangle's edges in winding order, exactly one edge crosses
  // from above-the-plane to below (downEntry) and one crosses from below to
  // above (upEntry). Always emitting the segment [downEntry -> upEntry]
  // (rather than "whichever crossing was found first") is what makes
  // segment orientation consistent across triangles sharing an edge, for a
  // consistently-wound, outward-facing mesh.
  let downEntry: Vec2 | null = null;
  let upEntry: Vec2 | null = null;
  for (let i = 0; i < 3; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % 3];
    const sa = sides[i];
    const sb = sides[(i + 1) % 3];
    if (sa !== sb) {
      const t = (planeZ - a.z) / (b.z - a.z);
      const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      if (sa === 1 && sb === -1) downEntry = p;
      else if (sa === -1 && sb === 1) upEntry = p;
    }
  }

  if (downEntry && upEntry) return [downEntry, upEntry];
  return null;
}

/** Chains directed segments (start-to-end matching within tolerance) into
 * closed polygon loops. Segments that cannot be closed are dropped. */
function chainSegments(segments: [Vec2, Vec2][]): Loop[] {
  const startMap = new Map<string, [Vec2, Vec2][]>();
  for (const seg of segments) {
    const k = key(seg[0]);
    const arr = startMap.get(k) ?? [];
    arr.push(seg);
    startMap.set(k, arr);
  }

  const used = new Set<[Vec2, Vec2]>();
  const loops: Loop[] = [];

  for (const seg of segments) {
    if (used.has(seg)) continue;
    const loop: Vec2[] = [seg[0]];
    let current = seg;
    used.add(current);
    let guard = 0;
    while (guard++ < segments.length + 5) {
      loop.push(current[1]);
      const endKey = key(current[1]);
      const startKey = key(seg[0]);
      if (endKey === startKey) break; // closed
      const candidates = startMap.get(endKey);
      const next = candidates?.find((c) => !used.has(c));
      if (!next) break; // open chain, discard below
      used.add(next);
      current = next;
    }
    // Only keep loops that closed back to the start with enough points.
    if (loop.length >= 4 && key(loop[0]) === key(loop[loop.length - 1])) {
      loop.pop();
      loops.push(loop);
    }
  }

  return loops;
}

export function sliceLayerLoops(triangles: Triangle[], planeZ: number): Loop[] {
  const segments: [Vec2, Vec2][] = [];
  for (const tri of triangles) {
    const seg = intersectTriangle(tri, planeZ);
    if (seg) segments.push(seg);
  }
  return chainSegments(segments);
}

export function computeBounds(triangles: Triangle[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const tri of triangles) {
    for (const v of [tri.a, tri.b, tri.c]) {
      if (v.x < min.x) min.x = v.x;
      if (v.y < min.y) min.y = v.y;
      if (v.z < min.z) min.z = v.z;
      if (v.x > max.x) max.x = v.x;
      if (v.y > max.y) max.y = v.y;
      if (v.z > max.z) max.z = v.z;
    }
  }
  return { min, max };
}

export function sliceMesh(triangles: Triangle[], settings: SliceSettings): SliceResult {
  const { min, max } = computeBounds(triangles);

  const layerZs: { z: number; h: number }[] = [];
  let z = min.z + settings.firstLayerHeightMm;
  layerZs.push({ z: z - settings.firstLayerHeightMm / 2, h: settings.firstLayerHeightMm });
  while (z < max.z - 1e-6) {
    const h = settings.layerHeightMm;
    const nextZ = Math.min(z + h, max.z);
    layerZs.push({ z: (z + nextZ) / 2, h: nextZ - z });
    z = nextZ;
  }

  const layers: SliceResult["layers"] = [];
  const filamentArea = Math.PI * (settings.filamentDiameterMm / 2) ** 2;
  let totalExtrudedVolumeMm3 = 0;
  let totalTimeSec = 0;

  const numLayers = layerZs.length;

  for (let i = 0; i < numLayers; i++) {
    const { z: planeZ, h } = layerZs[i];
    const rawLoops = sliceLayerLoops(triangles, planeZ);

    const perimeters: Loop[][] = [];
    for (const loop of rawLoops) {
      const insets: Loop[] = [];
      for (let w = 0; w < settings.wallLoops; w++) {
        const dist = settings.extrusionWidthMm * (0.5 + w);
        const inset = insetLoop(loop, dist);
        if (!inset) break;
        insets.push(inset);
      }
      if (insets.length === 0) insets.push(loop);
      perimeters.push(insets);
    }

    const innermostLoops = perimeters
      .map((insets) => insets[insets.length - 1])
      .filter((l): l is Loop => !!l);
    const innerBoundary = innermostLoops.map((l) => {
      const dist = settings.extrusionWidthMm * 0.5;
      return insetLoop(l, dist) ?? l;
    });

    const isTopBottom =
      i < settings.topBottomLayers || i >= numLayers - settings.topBottomLayers;

    let infill: [Vec2, Vec2][] = [];
    let solid: [Vec2, Vec2][] = [];
    const angle = (i % 2 === 0 ? 45 : 135) * (Math.PI / 180);

    if (innerBoundary.length > 0) {
      if (isTopBottom || settings.infillDensityPct >= 100) {
        solid = scanlineFill(innerBoundary, settings.extrusionWidthMm, angle);
      } else if (settings.infillDensityPct > 0) {
        const spacing = settings.extrusionWidthMm / (settings.infillDensityPct / 100);
        infill = scanlineFill(innerBoundary, spacing, angle);
      }
    }

    // --- Estimate extruded volume & time for this layer ---
    const speed = i === 0 ? settings.firstLayerSpeedMmS : settings.printSpeedMmS;
    let layerLengthMm = 0;
    for (const insets of perimeters) {
      for (const loop of insets) {
        layerLengthMm += loopPerimeterLength(loop);
      }
    }
    for (const [p1, p2] of [...infill, ...solid]) {
      layerLengthMm += dist2(p1, p2);
    }
    const crossSectionArea = settings.extrusionWidthMm * h;
    totalExtrudedVolumeMm3 += layerLengthMm * crossSectionArea;
    totalTimeSec += layerLengthMm / speed;
    // Add a rough travel-time allowance (10% overhead) plus per-layer Z hop/settle.
    totalTimeSec += 1.5;

    layers.push({ z: planeZ + h / 2, layerHeight: h, perimeters, infill, solid });
  }

  const estimatedFilamentMm = totalExtrudedVolumeMm3 / filamentArea;
  const PLA_DENSITY_G_PER_CM3 = 1.24;
  const estimatedFilamentGrams =
    (totalExtrudedVolumeMm3 / 1000) * PLA_DENSITY_G_PER_CM3;

  return {
    layers,
    boundsMin: min,
    boundsMax: max,
    estimatedTimeSec: totalTimeSec,
    estimatedFilamentMm,
    estimatedFilamentGrams,
    layerCount: layers.length,
  };
}

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function loopPerimeterLength(loop: Loop): number {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    total += dist2(loop[i], loop[(i + 1) % loop.length]);
  }
  return total;
}
