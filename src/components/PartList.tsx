"use client";

import type { PlacedPart } from "@/lib/scene/types";

export default function PartList({
  parts,
  selectedId,
  onSelect,
  onChange,
  onRemove,
  onDropToBed,
  overlappingIds,
}: {
  parts: PlacedPart[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Pick<PlacedPart, "position" | "rotationDeg" | "scale">>) => void;
  onRemove: (id: string) => void;
  onDropToBed: (id: string) => void;
  overlappingIds?: Set<string>;
}) {
  if (parts.length === 0) return null;
  const selected = parts.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-2">
      {overlappingIds && overlappingIds.size > 0 && (
        <div className="rounded border border-red-800 bg-red-950/40 px-2 py-1.5 text-xs text-red-300">
          ⚠️ {overlappingIds.size} パーツが重なっています。位置または回転を調整してください。
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {parts.map((part) => {
          const isOverlapping = overlappingIds?.has(part.id) ?? false;
          return (
            <li key={part.id}>
              <button
                onClick={() => onSelect(part.id === selectedId ? null : part.id)}
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                  isOverlapping
                    ? "bg-red-950/50 text-red-200 ring-1 ring-inset ring-red-800"
                    : part.id === selectedId
                      ? "bg-blue-600/20 text-blue-200"
                      : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {isOverlapping && <span title="他のパーツと重なっています">⚠️</span>}
                  <span className="truncate">{part.name}</span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(part.id);
                  }}
                  className="ml-2 shrink-0 text-zinc-500 hover:text-red-400"
                  title="削除"
                >
                  ✕
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/60 p-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-zinc-200">{selected.name}</span>
            <button
              onClick={() => onDropToBed(selected.id)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              ベッドに接地
            </button>
          </div>

          <Vec3Field
            label="位置 (mm)"
            value={selected.position}
            step={1}
            onChange={(v) => onChange(selected.id, { position: v })}
          />
          <Vec3Field
            label="回転 (°)"
            value={selected.rotationDeg}
            step={5}
            onChange={(v) => onChange(selected.id, { rotationDeg: v })}
          />
          <Vec3Field
            label="スケール"
            value={selected.scale}
            step={0.05}
            min={0.01}
            onChange={(v) => onChange(selected.id, { scale: v })}
          />
          <button
            onClick={() => {
              const uniform = selected.scale[0];
              onChange(selected.id, { scale: [uniform, uniform, uniform] });
            }}
            className="mt-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Xの値でXYZを揃える
          </button>
        </div>
      )}
    </div>
  );
}

function Vec3Field({
  label,
  value,
  onChange,
  step = 1,
  min,
}: {
  label: string;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
  step?: number;
  min?: number;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs text-zinc-500">{label}</div>
      <div className="grid grid-cols-3 gap-1.5">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <input
            key={axis}
            type="number"
            step={step}
            min={min}
            value={Number(value[i].toFixed(3))}
            onChange={(e) => {
              const next: [number, number, number] = [...value];
              const parsed = parseFloat(e.target.value);
              next[i] = Number.isFinite(parsed) ? parsed : value[i];
              onChange(next);
            }}
            className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-100"
          />
        ))}
      </div>
    </div>
  );
}
