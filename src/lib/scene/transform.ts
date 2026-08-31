import * as THREE from "three";
import type { PlacedPart } from "./types";

const DEG2RAD = Math.PI / 180;

export function partMatrix(part: PlacedPart): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const euler = new THREE.Euler(
    part.rotationDeg[0] * DEG2RAD,
    part.rotationDeg[1] * DEG2RAD,
    part.rotationDeg[2] * DEG2RAD,
    "XYZ"
  );
  const quat = new THREE.Quaternion().setFromEuler(euler);
  m.compose(
    new THREE.Vector3(...part.position),
    quat,
    new THREE.Vector3(...part.scale)
  );
  return m;
}

/** Applies a part's position/rotation/scale to a raw (local-space) triangle
 * soup, returning a new transformed Float32Array. */
export function applyPartTransform(position: Float32Array, part: PlacedPart): Float32Array {
  const m = partMatrix(part);
  const out = new Float32Array(position.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < position.length; i += 3) {
    v.set(position[i], position[i + 1], position[i + 2]);
    v.applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

/** World-space bounding box of a part after its transform is applied. */
export function partWorldBounds(part: PlacedPart): { min: THREE.Vector3; max: THREE.Vector3 } {
  const m = partMatrix(part);
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const corners: [number, number, number][] = [
    [part.localBoundsMin[0], part.localBoundsMin[1], part.localBoundsMin[2]],
    [part.localBoundsMax[0], part.localBoundsMin[1], part.localBoundsMin[2]],
    [part.localBoundsMin[0], part.localBoundsMax[1], part.localBoundsMin[2]],
    [part.localBoundsMax[0], part.localBoundsMax[1], part.localBoundsMin[2]],
    [part.localBoundsMin[0], part.localBoundsMin[1], part.localBoundsMax[2]],
    [part.localBoundsMax[0], part.localBoundsMin[1], part.localBoundsMax[2]],
    [part.localBoundsMin[0], part.localBoundsMax[1], part.localBoundsMax[2]],
    [part.localBoundsMax[0], part.localBoundsMax[1], part.localBoundsMax[2]],
  ];
  const v = new THREE.Vector3();
  for (const c of corners) {
    v.set(c[0], c[1], c[2]).applyMatrix4(m);
    min.min(v);
    max.max(v);
  }
  return { min, max };
}
