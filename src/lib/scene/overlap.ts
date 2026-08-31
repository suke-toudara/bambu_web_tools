import type { PlacedPart } from "./types";
import { partWorldBounds } from "./transform";

/**
 * Flags parts whose world-space axis-aligned bounding boxes intersect.
 * This is intentionally an AABB check, not exact mesh-vs-mesh collision: for
 * rotated parts it can report a false positive when their true (rotated)
 * hulls don't actually touch, but it never misses a real overlap, which
 * matters more for a "you're about to print two things on top of each
 * other" warning than pixel-perfect precision.
 */
export function findOverlappingPartIds(parts: PlacedPart[]): Set<string> {
  const overlapping = new Set<string>();
  if (parts.length < 2) return overlapping;

  const bounds = parts.map((part) => ({ id: part.id, ...partWorldBounds(part) }));
  const MARGIN = 0.01; // tolerance so parts merely touching at a shared edge don't flag

  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i];
      const b = bounds[j];
      const xOverlap = a.min.x < b.max.x - MARGIN && b.min.x < a.max.x - MARGIN;
      const yOverlap = a.min.y < b.max.y - MARGIN && b.min.y < a.max.y - MARGIN;
      const zOverlap = a.min.z < b.max.z - MARGIN && b.min.z < a.max.z - MARGIN;
      if (xOverlap && yOverlap && zOverlap) {
        overlapping.add(a.id);
        overlapping.add(b.id);
      }
    }
  }

  return overlapping;
}
