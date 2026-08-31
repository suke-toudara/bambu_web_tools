"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { OcctMesh } from "@/lib/occt/loadStep";

export default function ModelViewer({ meshes }: { meshes: OcctMesh[] | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111318);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
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

    const grid = new THREE.GridHelper(300, 30, 0x444a58, 0x2a2f3a);
    scene.add(grid);

    const group = new THREE.Group();
    scene.add(group);

    if (meshes && meshes.length > 0) {
      for (const mesh of meshes) {
        const geometry = new THREE.BufferGeometry();
        const posArray =
          mesh.attributes.position.array instanceof Float32Array
            ? mesh.attributes.position.array
            : new Float32Array(mesh.attributes.position.array);
        geometry.setAttribute("position", new THREE.BufferAttribute(posArray, 3));

        if (mesh.attributes.normal) {
          const normArray =
            mesh.attributes.normal.array instanceof Float32Array
              ? mesh.attributes.normal.array
              : new Float32Array(mesh.attributes.normal.array);
          geometry.setAttribute("normal", new THREE.BufferAttribute(normArray, 3));
        }

        const indexArray =
          mesh.index.array instanceof Uint32Array ? mesh.index.array : new Uint32Array(mesh.index.array);
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));

        if (!mesh.attributes.normal) geometry.computeVertexNormals();

        // occt-import-js returns [0, 0, 0] (rather than null) for STEP files
        // that don't carry explicit color metadata, so treat pure black as
        // "no color" and fall back to a visible default instead of
        // rendering an unlit-looking black solid.
        const hasColor = mesh.color && mesh.color.some((c) => c > 0.001);
        const color = hasColor
          ? new THREE.Color(mesh.color![0], mesh.color![1], mesh.color![2])
          : new THREE.Color(0x4f9dde);
        const material = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.15,
          roughness: 0.6,
          side: THREE.DoubleSide,
        });

        group.add(new THREE.Mesh(geometry, material));
      }

      // Center + frame the model.
      const box = new THREE.Box3().setFromObject(group);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      group.position.sub(center);

      const maxDim = Math.max(size.x, size.y, size.z, 1);
      camera.position.set(maxDim * 1.2, maxDim * 1.0, maxDim * 1.5);
      camera.near = maxDim / 100;
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    } else {
      camera.position.set(150, 120, 180);
      controls.update();
    }

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

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    };
  }, [meshes]);

  return <div ref={containerRef} className="h-full w-full" />;
}
