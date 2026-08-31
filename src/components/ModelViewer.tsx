"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PlacedPart } from "@/lib/scene/types";

const PART_PALETTE = [0x4f9dde, 0xe07a5f, 0x81b29a, 0xf2cc8f, 0x9d8df1, 0xe5989b, 0x6fb1a0, 0xd4a373];

export default function ModelViewer({
  parts,
  selectedId,
  onSelect,
  bedSizeXMm,
  bedSizeYMm,
}: {
  parts: PlacedPart[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  bedSizeXMm: number;
  bedSizeYMm: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef(parts);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);

  useEffect(() => {
    partsRef.current = parts;
    selectedRef.current = selectedId;
    onSelectRef.current = onSelect;
  });

  // Scene/camera/renderer are recreated only when the container mounts or
  // the bed size changes; part geometry is synced imperatively below so
  // dragging transform sliders doesn't tear down the WebGL context.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111318);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(1, 2, 3);
    scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight2.position.set(-2, -1, -2);
    scene.add(dirLight2);

    const grid = new THREE.GridHelper(
      Math.max(bedSizeXMm, bedSizeYMm) * 1.05,
      Math.round(Math.max(bedSizeXMm, bedSizeYMm) / 10),
      0x444a58,
      0x2a2f3a
    );
    grid.rotation.x = Math.PI / 2; // GridHelper defaults to the XZ plane; our bed is the XY plane.
    grid.position.set(bedSizeXMm / 2, bedSizeYMm / 2, 0);
    scene.add(grid);

    const bedOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(bedSizeXMm, 0, 0),
        new THREE.Vector3(bedSizeXMm, bedSizeYMm, 0),
        new THREE.Vector3(0, bedSizeYMm, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0x5b8def })
    );
    scene.add(bedOutline);

    const partsGroup = new THREE.Group();
    scene.add(partsGroup);
    let highlightBox: THREE.BoxHelper | null = null;

    const rebuildParts = () => {
      while (partsGroup.children.length > 0) {
        const child = partsGroup.children[0];
        partsGroup.remove(child);
        child.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material)?.dispose?.();
          }
        });
      }
      if (highlightBox) {
        scene.remove(highlightBox);
        highlightBox = null;
      }

      partsRef.current.forEach((part, partIndex) => {
        const group = new THREE.Group();
        group.userData.partId = part.id;
        group.position.set(...part.position);
        group.rotation.set(
          THREE.MathUtils.degToRad(part.rotationDeg[0]),
          THREE.MathUtils.degToRad(part.rotationDeg[1]),
          THREE.MathUtils.degToRad(part.rotationDeg[2]),
          "XYZ"
        );
        group.scale.set(...part.scale);

        part.meshes.forEach((mesh) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(mesh.position, 3));
          geometry.computeVertexNormals();

          const hasColor = mesh.color && mesh.color.some((c) => c > 0.001);
          const color = hasColor
            ? new THREE.Color(mesh.color![0], mesh.color![1], mesh.color![2])
            : new THREE.Color(PART_PALETTE[partIndex % PART_PALETTE.length]);
          const material = new THREE.MeshStandardMaterial({
            color,
            metalness: 0.15,
            roughness: 0.6,
            side: THREE.DoubleSide,
          });
          group.add(new THREE.Mesh(geometry, material));
        });

        partsGroup.add(group);
      });

      updateHighlight();
    };

    const updateHighlight = () => {
      if (highlightBox) {
        scene.remove(highlightBox);
        highlightBox = null;
      }
      const selected = partsGroup.children.find((c) => c.userData.partId === selectedRef.current);
      if (selected) {
        highlightBox = new THREE.BoxHelper(selected, 0xffee55);
        scene.add(highlightBox);
      }
    };

    rebuildParts();

    // Frame the whole plate on first build.
    const box = new THREE.Box3().setFromObject(partsGroup);
    const bedCenter = new THREE.Vector3(bedSizeXMm / 2, bedSizeYMm / 2, 0);
    const targetBox = box.isEmpty() ? new THREE.Box3(bedCenter.clone(), bedCenter.clone().addScalar(1)) : box.union(new THREE.Box3(bedCenter, bedCenter));
    const size = targetBox.getSize(new THREE.Vector3());
    const center = targetBox.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, bedSizeXMm * 0.3, 1);
    camera.position.set(center.x + maxDim * 1.1, center.y - maxDim * 1.4, center.z + maxDim * 1.1);
    camera.near = maxDim / 200;
    camera.far = maxDim * 200;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownPos: { x: number; y: number } | null = null;

    const onPointerDown = (ev: PointerEvent) => {
      pointerDownPos = { x: ev.clientX, y: ev.clientY };
    };
    const onPointerUp = (ev: PointerEvent) => {
      if (!pointerDownPos) return;
      const dx = ev.clientX - pointerDownPos.x;
      const dy = ev.clientY - pointerDownPos.y;
      pointerDownPos = null;
      if (Math.hypot(dx, dy) > 4) return; // was a drag/orbit, not a click

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(partsGroup.children, true);
      if (hits.length === 0) {
        onSelectRef.current(null);
        return;
      }
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.partId) obj = obj.parent;
      onSelectRef.current(obj ? (obj.userData.partId as string) : null);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Expose imperative update hooks used by the effects below.
    (container as unknown as { __viewer?: { rebuildParts: () => void; updateHighlight: () => void } }).__viewer = {
      rebuildParts,
      updateHighlight,
    };

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      partsGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          (mesh.material as THREE.Material)?.dispose?.();
        }
      });
    };
  }, [bedSizeXMm, bedSizeYMm]);

  // Re-sync geometry/transforms whenever parts change, without recreating
  // the renderer/camera (keeps the current camera angle stable).
  useEffect(() => {
    const container = containerRef.current as unknown as {
      __viewer?: { rebuildParts: () => void; updateHighlight: () => void };
    } | null;
    container?.__viewer?.rebuildParts();
  }, [parts]);

  useEffect(() => {
    const container = containerRef.current as unknown as {
      __viewer?: { rebuildParts: () => void; updateHighlight: () => void };
    } | null;
    container?.__viewer?.updateHighlight();
  }, [selectedId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
