import type { SliceSettings, SupportPillar, Triangle } from "./types";

interface BucketedTriangle {
  tri: Triangle;
  nz: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Barycentric point-in-triangle (2D, XY only) + interpolated Z at that point. */
function sampleTriangleAt(bt: BucketedTriangle, x: number, y: number): number | null {
  const { a, b, c } = bt.tri;
  const v0x = c.x - a.x, v0y = c.y - a.y;
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = x - a.x, v2y = y - a.y;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return null; // degenerate triangle in XY (near-vertical wall)

  const u = (dot11 * dot02 - dot01 * dot12) / denom; // weight toward c
  const v = (dot00 * dot12 - dot01 * dot02) / denom; // weight toward b
  if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) return null;

  const w = 1 - u - v; // weight toward a
  return w * a.z + v * b.z + u * c.z;
}

/**
 * Generates simple "build-plate only" square-section support pillars
 * beneath unsupported overhangs. For each column of a uniform XY grid,
 * casts a virtual vertical ray through the mesh and finds the bottom of the
 * lowest solid interval the mesh occupies there. If that bottom floats
 * above the plate (rather than resting on it) and is a steep enough
 * overhang, a pillar is planted from the plate up to just below it.
 *
 * Only the lowest interval per column is considered: this intentionally
 * does not support overhangs that would rest on the model itself (only on
 * the plate), matching the "support on build plate only" mode common to
 * most slicers, which keeps the geometry (and this implementation) simple.
 */
export function generateSupportPillars(triangles: Triangle[], settings: SliceSettings): SupportPillar[] {
  if (!settings.supportEnabled || triangles.length === 0) return [];

  const thresholdRad = (settings.supportOverhangAngleDeg * Math.PI) / 180;
  const nzThreshold = -Math.sin(thresholdRad);
  const spacing = Math.max(settings.supportSpacingMm, 0.5);

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity;
  const bucketed: BucketedTriangle[] = [];
  for (const tri of triangles) {
    const ux = tri.b.x - tri.a.x, uy = tri.b.y - tri.a.y, uz = tri.b.z - tri.a.z;
    const vx = tri.c.x - tri.a.x, vy = tri.c.y - tri.a.y, vz = tri.c.z - tri.a.z;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nzRaw = ux * vy - uy * vx;
    const nz = nzRaw / (Math.hypot(nx, ny, nzRaw) || 1);

    const triMinX = Math.min(tri.a.x, tri.b.x, tri.c.x);
    const triMaxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
    const triMinY = Math.min(tri.a.y, tri.b.y, tri.c.y);
    const triMaxY = Math.max(tri.a.y, tri.b.y, tri.c.y);
    bucketed.push({ tri, nz, minX: triMinX, maxX: triMaxX, minY: triMinY, maxY: triMaxY });

    if (triMinX < minX) minX = triMinX;
    if (triMaxX > maxX) maxX = triMaxX;
    if (triMinY < minY) minY = triMinY;
    if (triMaxY > maxY) maxY = triMaxY;
    if (tri.a.z < minZ) minZ = tri.a.z;
    if (tri.b.z < minZ) minZ = tri.b.z;
    if (tri.c.z < minZ) minZ = tri.c.z;
  }
  if (!isFinite(minX)) return [];

  // Spatial hash: bucket triangles into grid cells the size of the sampling
  // spacing so each ray only tests nearby candidates.
  const cellSize = spacing;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize) + 1);
  const buckets = new Map<number, BucketedTriangle[]>();
  const cellIndex = (cx: number, cy: number) => cy * cols + cx;

  for (const bt of bucketed) {
    const cx0 = Math.max(0, Math.floor((bt.minX - minX) / cellSize));
    const cx1 = Math.min(cols - 1, Math.floor((bt.maxX - minX) / cellSize));
    const cy0 = Math.max(0, Math.floor((bt.minY - minY) / cellSize));
    const cy1 = Math.min(rows - 1, Math.floor((bt.maxY - minY) / cellSize));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cellIndex(cx, cy);
        const arr = buckets.get(key);
        if (arr) arr.push(bt);
        else buckets.set(key, [bt]);
      }
    }
  }

  const pillars: SupportPillar[] = [];
  const restingEpsilon = 0.05;

  for (let cy = 0; cy < rows; cy++) {
    const y = minY + cy * cellSize + cellSize / 2;
    for (let cx = 0; cx < cols; cx++) {
      const x = minX + cx * cellSize + cellSize / 2;
      const candidates = buckets.get(cellIndex(cx, cy));
      if (!candidates) continue;

      const hits: { z: number; nz: number }[] = [];
      for (const bt of candidates) {
        if (x < bt.minX || x > bt.maxX || y < bt.minY || y > bt.maxY) continue;
        const z = sampleTriangleAt(bt, x, y);
        if (z === null) continue;
        hits.push({ z, nz: bt.nz });
      }
      if (hits.length < 2) continue;
      hits.sort((a, b) => a.z - b.z);

      // Pair hits into solid intervals assuming a closed, orientable mesh:
      // sorted ascending, hit 0 enters the first solid chunk, hit 1 exits
      // it, hit 2 enters the next, etc. We only care about the lowest
      // interval — "support on build plate only" never props up anything
      // that would rest on the model itself, so higher intervals (and any
      // void gaps between them) are intentionally ignored.
      const enter = hits[0];
      if (enter.z - minZ <= restingEpsilon) continue; // already resting on the plate
      if (enter.nz >= nzThreshold) continue; // shallow enough to self-support

      pillars.push({ x, y, topZ: enter.z - settings.supportTopGapMm });
    }
  }

  return pillars;
}

/** Builds the (already-centered) square footprint loop for a pillar, in the
 * same coordinate space as the sliced mesh — the caller offsets/centers it
 * onto the print bed along with everything else. */
export function pillarSquareLoop(pillar: SupportPillar, sizeMm: number): { x: number; y: number }[] {
  const half = sizeMm / 2;
  return [
    { x: pillar.x - half, y: pillar.y - half },
    { x: pillar.x + half, y: pillar.y - half },
    { x: pillar.x + half, y: pillar.y + half },
    { x: pillar.x - half, y: pillar.y + half },
  ];
}
