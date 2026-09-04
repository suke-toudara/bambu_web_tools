/** A single triangle soup (always non-indexed: length is a multiple of 9). */
export interface SceneMesh {
  position: Float32Array;
  color: [number, number, number] | null;
}

/** One independently movable object on the build plate. Multi-body STEP
 * assemblies and multi-object 3MF plates become multiple PlacedParts;
 * STL/OBJ files become a single part (optionally with several sub-meshes
 * for material/color grouping). */
export interface PlacedPart {
  id: string;
  name: string;
  meshes: SceneMesh[];
  /** Local-space bounding box of the raw (untransformed) geometry. */
  localBoundsMin: [number, number, number];
  localBoundsMax: [number, number, number];
  position: [number, number, number];
  rotationDeg: [number, number, number];
  scale: [number, number, number];
}

export function computeLocalBounds(meshes: SceneMesh[]): {
  min: [number, number, number];
  max: [number, number, number];
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    const p = mesh.position;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

let nextPartSeq = 1;
export function makePartId(): string {
  return `part-${Date.now()}-${nextPartSeq++}`;
}
