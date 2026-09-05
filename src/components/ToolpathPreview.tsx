"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ToolpathLayer } from "@/lib/slicer/toolpath";

type PathKind = "outerWall" | "innerWall" | "solid" | "infill" | "support";
type KindVisibility = Record<PathKind, boolean>;

const KINDS: { key: PathKind; label: string; color: number }[] = [
  { key: "outerWall", label: "外壁", color: 0xff8a3d },
  { key: "innerWall", label: "内壁", color: 0x4f9dde },
  { key: "solid", label: "上下ソリッド", color: 0xf2cc8f },
  { key: "infill", label: "インフィル", color: 0x7fd88f },
  { key: "support", label: "サポート", color: 0xb07cf0 },
];

type ToolpathHandle = {
  applyView: (topLayer: number, singleLayer: boolean, visible: KindVisibility) => void;
};

/** Flattens all layers of one kind into a single geometry, remembering how
 * many vertices each layer contributed. With one buffer per kind, showing
 * "layers 1..n" becomes a `setDrawRange` call rather than a rebuild, so the
 * layer slider stays smooth even on a tall model. */
function buildGeometry(layers: ToolpathLayer[], kind: PathKind) {
  let total = 0;
  for (const layer of layers) total += layer[kind].length / 2;

  const positions = new Float32Array(total * 3);
  const layerEndVertex = new Int32Array(layers.length);

  let v = 0;
  layers.forEach((layer, i) => {
    const flat = layer[kind];
    for (let j = 0; j < flat.length; j += 2) {
      positions[v * 3] = flat[j];
      positions[v * 3 + 1] = flat[j + 1];
      positions[v * 3 + 2] = layer.z;
      v++;
    }
    layerEndVertex[i] = v;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return { geometry, layerEndVertex, totalVertices: total };
}

export default function ToolpathPreview({
  layers,
  bedSizeXMm,
  bedSizeYMm,
}: {
  layers: ToolpathLayer[];
  bedSizeXMm: number;
  bedSizeYMm: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const [topLayer, setTopLayer] = useState(layers.length);
  const [singleLayer, setSingleLayer] = useState(false);
  const [visible, setVisible] = useState<KindVisibility>({
    outerWall: true,
    innerWall: true,
    solid: true,
    infill: true,
    support: true,
  });

  // Re-slicing changes the layer count; snap the slider back to the top of
  // the new print. Adjusting during render (rather than in an effect) avoids
  // a frame where the slider points past the end of the new toolpath.
  const [prevLayerCount, setPrevLayerCount] = useState(layers.length);
  if (prevLayerCount !== layers.length) {
    setPrevLayerCount(layers.length);
    setTopLayer(layers.length);
  }
  const clampedTop = Math.min(Math.max(topLayer, 1), Math.max(layers.length, 1));

  const nonEmptyKinds = useMemo(() => {
    const present = new Set<PathKind>();
    for (const layer of layers) {
      for (const { key } of KINDS) {
        if (layer[key].length > 0) present.add(key);
      }
    }
    return present;
  }, [layers]);

  // --- scene setup (rebuilt only when the sliced geometry itself changes) ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container || layers.length === 0) return;

    const width = container.clientWidth || 480;
    const height = container.clientHeight || 420;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    // Toolpath coordinates are Z-up (Z is the layer axis), so tell three.js
    // that rather than fighting its Y-up default in every transform.
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const bedMax = Math.max(bedSizeXMm, bedSizeYMm);
    const grid = new THREE.GridHelper(bedMax, Math.max(Math.round(bedMax / 10), 1), 0x3a3f4b, 0x23272f);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(bedSizeXMm / 2, bedSizeYMm / 2, 0);
    scene.add(grid);

    const lineSets: { kind: PathKind; line: THREE.LineSegments; layerEndVertex: Int32Array }[] = [];
    for (const { key, color } of KINDS) {
      const { geometry, layerEndVertex, totalVertices } = buildGeometry(layers, key);
      if (totalVertices === 0) {
        geometry.dispose();
        continue;
      }
      const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
      scene.add(line);
      lineSets.push({ kind: key, line, layerEndVertex });
    }

    const applyView: ToolpathHandle["applyView"] = (top, single, vis) => {
      for (const { kind, line, layerEndVertex } of lineSets) {
        line.visible = vis[kind];
        const end = layerEndVertex[top - 1] ?? 0;
        const start = single && top >= 2 ? (layerEndVertex[top - 2] ?? 0) : 0;
        line.geometry.setDrawRange(start, Math.max(end - start, 0));
      }
    };
    // The view effect below runs right after this one on mount (and again
    // whenever `layers` changes), so it applies the current layer range and
    // visibility — no need to duplicate that here.
    const handleHost = container as unknown as { __toolpath?: ToolpathHandle };
    handleHost.__toolpath = { applyView };

    // Frame the print.
    const box = new THREE.Box3();
    for (const { line } of lineSets) {
      line.geometry.computeBoundingBox();
      if (line.geometry.boundingBox) box.union(line.geometry.boundingBox);
    }
    const center = box.isEmpty()
      ? new THREE.Vector3(bedSizeXMm / 2, bedSizeYMm / 2, 0)
      : box.getCenter(new THREE.Vector3());
    const radius = box.isEmpty() ? 100 : Math.max(box.getSize(new THREE.Vector3()).length(), 10);
    camera.position.set(center.x + radius, center.y - radius, center.z + radius * 0.8);
    controls.target.copy(center);
    controls.update();

    let frame = 0;
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      const w = container.clientWidth || width;
      const h = container.clientHeight || height;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      delete handleHost.__toolpath;
      controls.dispose();
      for (const { line } of lineSets) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [layers, bedSizeXMm, bedSizeYMm]);

  // Cheap updates: which layers and which path kinds are drawn. Goes through
  // the handle the scene published, so changing them never rebuilds the
  // scene or moves the camera.
  useEffect(() => {
    const host = containerRef.current as unknown as { __toolpath?: ToolpathHandle } | null;
    host?.__toolpath?.applyView(clampedTop, singleLayer, visible);
  }, [layers, clampedTop, singleLayer, visible]);

  if (layers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div ref={containerRef} className="h-[420px] w-full overflow-hidden rounded border border-zinc-700" />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        {KINDS.filter((k) => nonEmptyKinds.has(k.key)).map((k) => (
          <label key={k.key} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={visible[k.key]}
              onChange={(e) => setVisible((v) => ({ ...v, [k.key]: e.target.checked }))}
            />
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: `#${k.color.toString(16).padStart(6, "0")}` }}
            />
            {k.label}
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3 text-sm text-zinc-300">
        <span className="whitespace-nowrap">
          Layer {clampedTop}/{layers.length}
        </span>
        <input
          type="range"
          min={1}
          max={Math.max(layers.length, 1)}
          value={clampedTop}
          onChange={(e) => setTopLayer(Number(e.target.value))}
          className="flex-1"
        />
        <span className="whitespace-nowrap">z={layers[clampedTop - 1].z.toFixed(2)}mm</span>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={singleLayer} onChange={(e) => setSingleLayer(e.target.checked)} />
        この層だけ表示(積み上げ表示をやめる)
      </label>
      <p className="text-xs text-zinc-500">ドラッグで回転、ホイールでズーム、右ドラッグで平行移動できます。</p>
    </div>
  );
}
