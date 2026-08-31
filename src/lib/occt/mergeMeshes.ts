import type { OcctMesh } from "./loadStep";

/** Flattens one or more indexed sub-meshes into a single non-indexed
 * position buffer (expanded triangle soup), suitable for STL export /
 * slicing where per-part material/color doesn't matter. */
export function mergeMeshesToTriangleSoup(meshes: OcctMesh[]): Float32Array {
  let triCount = 0;
  for (const mesh of meshes) triCount += mesh.index.array.length / 3;

  const out = new Float32Array(triCount * 9);
  let outOffset = 0;

  for (const mesh of meshes) {
    const pos = mesh.attributes.position.array;
    const idx = mesh.index.array;
    for (let i = 0; i < idx.length; i++) {
      const vi = idx[i] * 3;
      out[outOffset++] = pos[vi];
      out[outOffset++] = pos[vi + 1];
      out[outOffset++] = pos[vi + 2];
    }
  }

  return out;
}
