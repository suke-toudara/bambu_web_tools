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

/**
 * Returns a copy of `part` rotated so the given world-space face normal
 * (as picked by clicking a face in the viewer) points straight down,
 * i.e. that face becomes flush with the build plate — a "place on face"
 * operation common to CAD/slicer tools. The part is also re-seated so its
 * lowest point sits at z=0 afterward, since reorienting around the part's
 * own pivot will generally lift or sink it relative to the plate.
 */
export function placePartOnFaceDown(part: PlacedPart, worldNormal: [number, number, number]): PlacedPart {
  const currentEuler = new THREE.Euler(
    part.rotationDeg[0] * DEG2RAD,
    part.rotationDeg[1] * DEG2RAD,
    part.rotationDeg[2] * DEG2RAD,
    "XYZ"
  );
  const currentQuat = new THREE.Quaternion().setFromEuler(currentEuler);

  const normal = new THREE.Vector3(...worldNormal).normalize();
  const down = new THREE.Vector3(0, 0, -1);
  const deltaQuat = new THREE.Quaternion().setFromUnitVectors(normal, down);
  const newQuat = deltaQuat.multiply(currentQuat);

  const newEuler = new THREE.Euler().setFromQuaternion(newQuat, "XYZ");
  const rotated: PlacedPart = {
    ...part,
    rotationDeg: [
      THREE.MathUtils.radToDeg(newEuler.x),
      THREE.MathUtils.radToDeg(newEuler.y),
      THREE.MathUtils.radToDeg(newEuler.z),
    ],
  };

  const { min } = partWorldBounds(rotated);
  return {
    ...rotated,
    position: [rotated.position[0], rotated.position[1], rotated.position[2] - min.z],
  };
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
