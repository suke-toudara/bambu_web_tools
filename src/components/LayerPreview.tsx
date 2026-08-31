"use client";

import { useEffect, useRef, useState } from "react";
import type { Vec2 } from "@/lib/slicer/types";

export interface LayerPreviewData {
  z: number;
  perimeters: Vec2[][][]; // per loop: list of inset loops
}

export default function LayerPreview({ layers }: { layers: LayerPreviewData[] }) {
  const [rawIndex, setIndex] = useState(0);
  const index = Math.min(rawIndex, Math.max(layers.length - 1, 0));
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || layers.length === 0) return;
    const layer = layers[index];
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#0f1117";
    ctx.fillRect(0, 0, w, h);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const insets of layer.perimeters) {
      for (const loop of insets) {
        for (const p of loop) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
    }
    if (!isFinite(minX)) return;

    const pad = 20;
    const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1));
    const toCanvas = (p: Vec2) => ({
      x: pad + (p.x - minX) * scale,
      y: h - (pad + (p.y - minY) * scale),
    });

    layer.perimeters.forEach((insets, loopIdx) => {
      insets.forEach((loop, k) => {
        if (loop.length < 2) return;
        ctx.beginPath();
        const start = toCanvas(loop[0]);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i <= loop.length; i++) {
          const p = toCanvas(loop[i % loop.length]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = k === 0 ? "#4f9dde" : "#7fd88f";
        ctx.lineWidth = k === 0 ? 1.5 : 1;
        ctx.stroke();
        void loopIdx;
      });
    });
  }, [layers, index]);

  if (layers.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <canvas ref={canvasRef} width={480} height={480} className="w-full rounded border border-zinc-700 bg-black" />
      <div className="flex items-center gap-3 text-sm text-zinc-300">
        <span>Layer {index + 1}/{layers.length}</span>
        <input
          type="range"
          min={0}
          max={layers.length - 1}
          value={index}
          onChange={(e) => setIndex(Number(e.target.value))}
          className="flex-1"
        />
        <span>z={layers[index].z.toFixed(2)}mm</span>
      </div>
    </div>
  );
}
