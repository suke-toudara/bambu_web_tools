"use client";

import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js";
import { parseStepFile } from "@/lib/occt/loadStep";
import { computeLocalBounds, makePartId, type PlacedPart, type SceneMesh } from "@/lib/scene/types";

function identityPart(name: string, meshes: SceneMesh[]): PlacedPart {
  const { min, max } = computeLocalBounds(meshes);
  return {
    id: makePartId(),
    name,
    meshes,
    localBoundsMin: min,
    localBoundsMax: max,
    position: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

/** Traverses from `root`, baking each descendant mesh's transform *relative
 * to `root`* into its vertex positions (root's own position/rotation/scale
 * are ignored/treated as identity — the caller supplies those separately,
 * e.g. from a 3MF build item's transform). Handles flat single-mesh objects
 * (STL/OBJ) and nested multi-mesh "components" (3MF) uniformly. */
function collectBakedMeshes(root: THREE.Object3D): SceneMesh[] {
  const clone = root.clone(true);
  clone.position.set(0, 0, 0);
  clone.quaternion.identity();
  clone.scale.set(1, 1, 1);
  clone.updateMatrixWorld(true);

  const meshes: SceneMesh[] = [];
  clone.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    if (geometry.index) geometry = geometry.toNonIndexed();
    const posAttr = geometry.getAttribute("position");
    if (!posAttr) return;

    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const matColor = (material as THREE.MeshStandardMaterial | undefined)?.color;
    const color: [number, number, number] | null = matColor ? [matColor.r, matColor.g, matColor.b] : null;

    meshes.push({
      position: new Float32Array(posAttr.array as ArrayLike<number>),
      color,
    });
    geometry.dispose();
  });
  return meshes;
}

async function loadStepParts(buffer: ArrayBuffer, baseName: string): Promise<PlacedPart[]> {
  const result = await parseStepFile(buffer);
  const multi = result.meshes.length > 1;
  return result.meshes.map((mesh, i) => {
    const posArray = mesh.attributes.position.array;
    const idxArray = mesh.index.array;
    const position = new Float32Array(idxArray.length * 3);
    for (let t = 0; t < idxArray.length; t++) {
      const vi = idxArray[t] * 3;
      position[t * 3] = posArray[vi];
      position[t * 3 + 1] = posArray[vi + 1];
      position[t * 3 + 2] = posArray[vi + 2];
    }
    const hasColor = mesh.color && mesh.color.some((c) => c > 0.001);
    const sceneMesh: SceneMesh = {
      position,
      color: hasColor ? (mesh.color as [number, number, number]) : null,
    };
    const name = multi ? `${baseName} #${i + 1}` : baseName;
    return identityPart(name, [sceneMesh]);
  });
}

function loadStlPart(buffer: ArrayBuffer, baseName: string): PlacedPart {
  const geometry = new STLLoader().parse(buffer);
  const mesh = new THREE.Mesh(geometry);
  const meshes = collectBakedMeshes(mesh);
  return identityPart(baseName, meshes);
}

function loadObjPart(text: string, baseName: string): PlacedPart {
  const group = new OBJLoader().parse(text);
  const meshes = collectBakedMeshes(group);
  return identityPart(baseName, meshes);
}

function load3mfParts(buffer: ArrayBuffer, baseName: string): PlacedPart[] {
  const group = new ThreeMFLoader().parse(buffer) as THREE.Group;
  const items = group.children.filter((c) => {
    let hasMesh = false;
    c.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) hasMesh = true;
    });
    return hasMesh;
  });
  const multi = items.length > 1;

  return items.map((child, i) => {
    const meshes = collectBakedMeshes(child);
    const part = identityPart(multi ? `${baseName} #${i + 1}` : baseName, meshes);
    // 3MF build items carry their plate transform on the child object
    // (already decomposed by ThreeMFLoader's applyMatrix4 call).
    part.position = [child.position.x, child.position.y, child.position.z];
    const euler = new THREE.Euler().setFromQuaternion(child.quaternion, "XYZ");
    part.rotationDeg = [
      THREE.MathUtils.radToDeg(euler.x),
      THREE.MathUtils.radToDeg(euler.y),
      THREE.MathUtils.radToDeg(euler.z),
    ];
    part.scale = [child.scale.x, child.scale.y, child.scale.z];
    return part;
  });
}

export type SupportedExtension = "step" | "stp" | "stl" | "obj" | "3mf";

export function detectExtension(fileName: string): SupportedExtension | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "step" || ext === "stp" || ext === "stl" || ext === "obj" || ext === "3mf") return ext;
  return null;
}

/** Loads a 3D model file (.step/.stp/.stl/.obj/.3mf) into one or more
 * PlacedParts (still at their file-authored / identity transform — the
 * caller is expected to auto-arrange them onto the plate afterward). */
export async function loadModelFile(file: File): Promise<PlacedPart[]> {
  const ext = detectExtension(file.name);
  const baseName = file.name.replace(/\.[^.]+$/, "");
  if (!ext) {
    throw new Error(`対応していないファイル形式です: ${file.name}`);
  }

  if (ext === "step" || ext === "stp") {
    return loadStepParts(await file.arrayBuffer(), baseName);
  }
  if (ext === "stl") {
    return [loadStlPart(await file.arrayBuffer(), baseName)];
  }
  if (ext === "obj") {
    return [loadObjPart(await file.text(), baseName)];
  }
  return load3mfParts(await file.arrayBuffer(), baseName);
}
