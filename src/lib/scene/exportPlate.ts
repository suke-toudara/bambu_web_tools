import type { PlacedPart } from "./types";
import { applyPartTransform } from "./transform";

/** Combines every part's (transformed) triangle soup into one flat
 * non-indexed position buffer, in shared plate/bed coordinates — ready to
 * hand to the slicer as a single mesh. Our planar slicer naturally handles
 * multiple disjoint solids per layer, so no further special-casing is
 * needed for multi-part plates. */
export function exportPlateTriangleSoup(parts: PlacedPart[]): Float32Array {
  let total = 0;
  for (const part of parts) {
    for (const mesh of part.meshes) total += mesh.position.length;
  }
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    for (const mesh of part.meshes) {
      const transformed = applyPartTransform(mesh.position, part);
      out.set(transformed, offset);
      offset += transformed.length;
    }
  }
  return out;
}
