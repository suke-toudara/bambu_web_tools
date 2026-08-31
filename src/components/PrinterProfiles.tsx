"use client";

import { useState } from "react";

export interface SavedPrinter {
  id: string;
  name: string;
  host: string;
  serial: string;
  accessCode: string;
}

export default function PrinterProfiles({
  printers,
  activeId,
  onSelect,
  onSaveNew,
  onUpdateActive,
  onRemove,
}: {
  printers: SavedPrinter[];
  activeId: string | null;
  onSelect: (printer: SavedPrinter) => void;
  onSaveNew: (name: string) => void;
  onUpdateActive: () => void;
  onRemove: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");

  return (
    <div className="mb-3">
      {printers.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {printers.map((p) => (
            <li key={p.id}>
              <span
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  p.id === activeId
                    ? "border-blue-500 bg-blue-600/20 text-blue-200"
                    : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <button onClick={() => onSelect(p)} className="max-w-[10rem] truncate">
                  {p.name}
                </button>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => onRemove(p.id)}
                  className="text-zinc-500 hover:text-red-400"
                  title="削除"
                >
                  ✕
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="プリンターの名前 (例: リビングのP1S)"
          className="min-w-[10rem] flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
        />
        <button
          onClick={() => {
            if (!newName.trim()) return;
            onSaveNew(newName.trim());
            setNewName("");
          }}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          新規に保存
        </button>
        {activeId && (
          <button
            onClick={onUpdateActive}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            現在の接続で上書き
          </button>
        )}
      </div>
    </div>
  );
}
