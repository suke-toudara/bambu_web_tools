import type { PlacedPart } from "./types";
import { partWorldBounds } from "./transform";

const MARGIN_MM = 5;

/**
 * Places a freshly-imported batch of parts (still at identity transform) on
 * the plate: each part is dropped so its bottom rests at z=0, the batch's
 * relative XY arrangement (as authored in the source file) is preserved,
 * and the whole batch is shifted to an empty "shelf" area of the bed that
 * doesn't overlap parts already placed. This is a simple left-to-right,
 * wrap-to-next-row heuristic, not true bin packing.
 */
export function autoPlaceBatch(
  batch: PlacedPart[],
  existing: PlacedPart[],
  bedSizeXMm: number,
  bedSizeYMm: number
): PlacedPart[] {
  if (batch.length === 0) return batch;

  // Drop each part to rest on the plate individually.
  const dropped = batch.map((part) => ({
    ...part,
    position: [part.position[0], part.position[1], -part.localBoundsMin[2] * part.scale[2]] as [
      number,
      number,
      number,
    ],
  }));

  // Combined XY footprint of the batch (after the per-part Z drop; XY unaffected).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of dropped) {
    const { min, max } = partWorldBounds(part);
    if (min.x < minX) minX = min.x;
    if (min.y < minY) minY = min.y;
    if (max.x > maxX) maxX = max.x;
    if (max.y > maxY) maxY = max.y;
  }
  const batchWidth = maxX - minX;
  const batchDepth = maxY - minY;
  const batchCenterX = (minX + maxX) / 2;
  const batchCenterY = (minY + maxY) / 2;

  let targetCenterX = bedSizeXMm / 2;
  let targetCenterY = bedSizeYMm / 2;

  if (existing.length > 0) {
    let existMinX = Infinity, existMaxX = -Infinity, existMaxY = -Infinity, existMinY = Infinity;
    for (const part of existing) {
      const { min, max } = partWorldBounds(part);
      if (min.x < existMinX) existMinX = min.x;
      if (max.x > existMaxX) existMaxX = max.x;
      if (min.y < existMinY) existMinY = min.y;
      if (max.y > existMaxY) existMaxY = max.y;
    }

    let candidateLeft = existMaxX + MARGIN_MM;
    if (candidateLeft + batchWidth > bedSizeXMm) {
      // Wrap to a new row above the tallest existing row.
      candidateLeft = MARGIN_MM;
      targetCenterY = existMaxY + MARGIN_MM + batchDepth / 2;
    } else {
      targetCenterY = (existMinY + existMaxY) / 2;
    }
    targetCenterX = candidateLeft + batchWidth / 2;
  }

  const offsetX = targetCenterX - batchCenterX;
  const offsetY = targetCenterY - batchCenterY;

  return dropped.map((part) => ({
    ...part,
    position: [part.position[0] + offsetX, part.position[1] + offsetY, part.position[2]],
  }));
}
