"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { loadModelFile } from "@/lib/loaders/loadModelFile";
import { autoPlaceBatch } from "@/lib/scene/autoPlace";
import { exportPlateTriangleSoup } from "@/lib/scene/exportPlate";
import { findOverlappingPartIds } from "@/lib/scene/overlap";
import { partWorldBounds, placePartOnFaceDown } from "@/lib/scene/transform";
import type { PlacedPart } from "@/lib/scene/types";
import { meshToBinaryStl } from "@/lib/stl/exportBinaryStl";
import { DEFAULT_SLICE_SETTINGS, type SliceSettings } from "@/lib/slicer/types";
import type { ToolpathLayer } from "@/lib/slicer/toolpath";
import {
  FILAMENT_PROFILES,
  applyFilamentProfile,
  getFilamentProfile,
  matchesFilamentProfile,
} from "@/lib/slicer/filaments";
import type { FilamentId, InfillPattern } from "@/lib/slicer/types";
import { INFILL_PATTERNS, getInfillPattern } from "@/lib/slicer/infill";
import PartList from "@/components/PartList";
import PrinterProfiles, { type SavedPrinter } from "@/components/PrinterProfiles";

const ModelViewer = dynamic(() => import("@/components/ModelViewer"), { ssr: false });
const ToolpathPreview = dynamic(() => import("@/components/ToolpathPreview"), { ssr: false });

interface SliceStats {
  layerCount: number;
  estimatedTimeSec: number;
  estimatedFilamentMm: number;
  estimatedFilamentGrams: number;
  boundsMin: { x: number; y: number; z: number };
  boundsMax: { x: number; y: number; z: number };
}

interface PrinterConn {
  host: string;
  serial: string;
  accessCode: string;
}

const STORAGE_KEY = "bambu-web-tools:printer";
const PRINTERS_STORAGE_KEY = "bambu-web-tools:printers";
const ACTIVE_PRINTER_STORAGE_KEY = "bambu-web-tools:activePrinterId";
const MIGRATED_PRINTER_ID = "printer-migrated-1";
const STATUS_POLL_MS = 5000;

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Read localStorage directly in useState lazy initializers (rather than an
// effect that calls setState after mount) so the very first render already
// has the persisted value. Effect-based hydration raced with React 18
// Strict Mode's double-invoked mount effects: the "write current state"
// effect would run with the still-default value between the two hydration
// passes and permanently clobber a real saved connection on reload.
function loadPrinterConn(): PrinterConn {
  if (typeof window === "undefined") return { host: "", serial: "", accessCode: "" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return { host: "", serial: "", accessCode: "" };
}

function loadSavedPrinters(): SavedPrinter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(PRINTERS_STORAGE_KEY);
    const list: SavedPrinter[] = raw ? JSON.parse(raw) : [];
    if (list.length > 0) return list;
  } catch {
    // ignore
  }
  // Migrate a pre-existing single-printer connection (from before named
  // profiles existed) into a named entry, so upgrading doesn't lose it.
  const conn = loadPrinterConn();
  if (conn.host) return [{ id: MIGRATED_PRINTER_ID, name: "プリンター1", ...conn }];
  return [];
}

function loadActivePrinterId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PRINTERS_STORAGE_KEY);
    if (raw && JSON.parse(raw).length > 0) {
      return localStorage.getItem(ACTIVE_PRINTER_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  // No saved list yet: mirror loadSavedPrinters()'s migration decision.
  return loadPrinterConn().host ? MIGRATED_PRINTER_ID : null;
}

export default function Home() {
  const [parts, setParts] = useState<PlacedPart[]>([]);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [pickFaceMode, setPickFaceMode] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [settings, setSettings] = useState<SliceSettings>(DEFAULT_SLICE_SETTINGS);
  const [slicing, setSlicing] = useState(false);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [gcode, setGcode] = useState<string | null>(null);
  const [stats, setStats] = useState<SliceStats | null>(null);
  const [toolpath, setToolpath] = useState<ToolpathLayer[]>([]);

  const [printer, setPrinter] = useState<PrinterConn>(loadPrinterConn);
  const [savedPrinters, setSavedPrinters] = useState<SavedPrinter[]>(loadSavedPrinters);
  const [activePrinterId, setActivePrinterId] = useState<string | null>(loadActivePrinterId);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [printerStatus, setPrinterStatus] = useState<any>(null);

  const [printBusy, setPrintBusy] = useState(false);
  const [printMessage, setPrintMessage] = useState<string | null>(null);
  const [printErrorMsg, setPrintErrorMsg] = useState<string | null>(null);

  const [projectFile, setProjectFile] = useState<File | null>(null);

  const [rightTab, setRightTab] = useState<"slice" | "print">("slice");
  const [printMode, setPrintMode] = useState<"gcode" | "project">("gcode");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(printer));
    } catch {
      // ignore
    }
  }, [printer]);

  useEffect(() => {
    try {
      localStorage.setItem(PRINTERS_STORAGE_KEY, JSON.stringify(savedPrinters));
    } catch {
      // ignore
    }
  }, [savedPrinters]);

  useEffect(() => {
    try {
      if (activePrinterId) localStorage.setItem(ACTIVE_PRINTER_STORAGE_KEY, activePrinterId);
      else localStorage.removeItem(ACTIVE_PRINTER_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [activePrinterId]);

  function handleSelectSavedPrinter(p: SavedPrinter) {
    setPrinter({ host: p.host, serial: p.serial, accessCode: p.accessCode });
    setActivePrinterId(p.id);
    setPrinterStatus(null);
    setStatusError(null);
  }

  function handleSaveNewPrinter(name: string) {
    const entry: SavedPrinter = { id: `printer-${Date.now()}`, name, ...printer };
    setSavedPrinters((prev) => [...prev, entry]);
    setActivePrinterId(entry.id);
  }

  function handleUpdateActivePrinter() {
    if (!activePrinterId) return;
    setSavedPrinters((prev) => prev.map((p) => (p.id === activePrinterId ? { ...p, ...printer } : p)));
  }

  function handleRemoveSavedPrinter(id: string) {
    setSavedPrinters((prev) => prev.filter((p) => p.id !== id));
    setActivePrinterId((prev) => (prev === id ? null : prev));
  }

  function invalidateSlice() {
    setGcode(null);
    setStats(null);
    setToolpath([]);
  }

  async function handleFiles(files: FileList) {
    setLoadError(null);
    setLoadingFiles(true);
    let alreadySelected = selectedPartId !== null;
    try {
      for (const file of Array.from(files)) {
        const batch = await loadModelFile(file);
        setParts((prev) => {
          const placed = autoPlaceBatch(batch, prev, settings.bedSizeXMm, settings.bedSizeYMm);
          if (!alreadySelected && placed.length > 0) {
            alreadySelected = true;
            setSelectedPartId(placed[0].id);
          }
          return [...prev, ...placed];
        });
      }
      invalidateSlice();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "モデルの読み込みに失敗しました。");
    } finally {
      setLoadingFiles(false);
    }
  }

  function handlePartChange(id: string, patch: Partial<Pick<PlacedPart, "position" | "rotationDeg" | "scale">>) {
    setParts((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    invalidateSlice();
  }

  function handleRemovePart(id: string) {
    setParts((prev) => prev.filter((p) => p.id !== id));
    setSelectedPartId((prev) => (prev === id ? null : prev));
    invalidateSlice();
  }

  function handleDropToBed(id: string) {
    setParts((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const { min } = partWorldBounds(p);
        return { ...p, position: [p.position[0], p.position[1], p.position[2] - min.z] };
      })
    );
    invalidateSlice();
  }

  function handleClearAll() {
    setParts([]);
    setSelectedPartId(null);
    invalidateSlice();
  }

  function handleFacePicked(id: string, worldNormal: [number, number, number]) {
    setParts((prev) => prev.map((p) => (p.id === id ? placePartOnFaceDown(p, worldNormal) : p)));
    setSelectedPartId(id);
    setPickFaceMode(false);
    invalidateSlice();
  }

  const stlBlob = useMemo(() => {
    if (parts.length === 0) return null;
    const soup = exportPlateTriangleSoup(parts);
    return meshToBinaryStl(soup, null);
  }, [parts]);

  const overlappingIds = useMemo(() => findOverlappingPartIds(parts), [parts]);

  async function handleSlice() {
    if (!stlBlob) return;
    setSlicing(true);
    setSliceError(null);
    invalidateSlice();
    try {
      const form = new FormData();
      form.append("file", stlBlob, "plate.stl");
      form.append("settings", JSON.stringify(settings));
      const res = await fetch("/api/slice", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Slicing failed.");
      setGcode(data.gcode);
      setStats(data.stats);
      setToolpath(data.toolpath);
    } catch (err) {
      setSliceError(err instanceof Error ? err.message : "Slicing failed.");
    } finally {
      setSlicing(false);
    }
  }

  function downloadGcode() {
    if (!gcode) return;
    const blob = new Blob([gcode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plate.gcode";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadStl() {
    if (!stlBlob) return;
    const url = URL.createObjectURL(stlBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plate.stl";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function fetchStatus() {
    setStatusError(null);
    try {
      const res = await fetch("/api/printer/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(printer),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to get status.");
      setPrinterStatus(data);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to get status.");
      setPrinterStatus(null);
    }
  }

  async function handleGetStatus() {
    setStatusLoading(true);
    await fetchStatus();
    setStatusLoading(false);
  }

  // Auto-poll printer status while the print tab is open and a host is set.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (rightTab !== "print" || !autoRefresh || !printer.host) return;
    if (!pollingRef.current) {
      pollingRef.current = true;
      void fetchStatus();
    }
    const id = setInterval(() => void fetchStatus(), STATUS_POLL_MS);
    return () => {
      clearInterval(id);
      pollingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightTab, autoRefresh, printer.host, printer.serial, printer.accessCode]);

  async function handlePrintGcode() {
    if (!gcode) return;
    setPrintBusy(true);
    setPrintMessage(null);
    setPrintErrorMsg(null);
    try {
      const res = await fetch("/api/printer/print-gcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...printer, gcode, fileName: "plate.gcode" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to start print.");
      setPrintMessage(`印刷を開始しました: ${data.remotePath}`);
    } catch (err) {
      setPrintErrorMsg(err instanceof Error ? err.message : "Failed to start print.");
    } finally {
      setPrintBusy(false);
    }
  }

  async function handlePrintProject() {
    if (!projectFile) return;
    setPrintBusy(true);
    setPrintMessage(null);
    setPrintErrorMsg(null);
    try {
      const form = new FormData();
      form.append("file", projectFile);
      form.append("host", printer.host);
      form.append("serial", printer.serial);
      form.append("accessCode", printer.accessCode);
      const res = await fetch("/api/printer/print-project", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Failed to start print.");
      setPrintMessage(`印刷を開始しました: ${data.remotePath} (plate ${data.plateFile})`);
    } catch (err) {
      setPrintErrorMsg(err instanceof Error ? err.message : "Failed to start print.");
    } finally {
      setPrintBusy(false);
    }
  }

  async function handleControl(action: "pause" | "resume" | "stop") {
    setPrintBusy(true);
    setPrintMessage(null);
    setPrintErrorMsg(null);
    try {
      const res = await fetch("/api/printer/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...printer, action }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Command failed.");
      const labels: Record<string, string> = { pause: "一時停止", resume: "再開", stop: "停止" };
      setPrintMessage(`「${labels[action]}」を送信しました`);
    } catch (err) {
      setPrintErrorMsg(err instanceof Error ? err.message : "Command failed.");
    } finally {
      setPrintBusy(false);
    }
  }

  const step = parts.length === 0 ? 1 : !stats ? 2 : 3;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Bambu Web Tools</h1>
          <p className="text-xs text-zinc-500">モデル表示・スライス・Bambuプリンター印刷</p>
        </div>
        <ol className="flex items-center gap-2 text-xs text-zinc-400">
          <StepBadge n={1} label="モデル配置" active={step === 1} done={step > 1} />
          <StepArrow />
          <StepBadge n={2} label="スライス" active={step === 2} done={step > 2} />
          <StepArrow />
          <StepBadge n={3} label="印刷" active={step === 3} done={false} />
        </ol>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Left: upload + viewer + part list */}
        <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <Card className="flex-none">
            <div className="flex items-center justify-between">
              <label className="mb-1 block text-sm font-medium text-zinc-300">
                1. モデルを追加 (.step/.stp/.stl/.obj/.3mf, 複数選択可)
              </label>
              {parts.length > 0 && (
                <button onClick={handleClearAll} className="text-xs text-zinc-500 hover:text-red-400">
                  すべて削除
                </button>
              )}
            </div>
            <input
              type="file"
              multiple
              accept=".step,.stp,.stl,.obj,.3mf"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
                e.target.value = "";
              }}
              className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-blue-500"
            />
            {loadingFiles && <p className="mt-2 text-sm text-amber-400">読み込み中...</p>}
            {loadError && <p className="mt-2 text-sm text-red-400">{loadError}</p>}
            {parts.length > 0 && !loadingFiles && (
              <p className="mt-2 text-sm text-emerald-400">{parts.length} パーツをプレート上に配置しました</p>
            )}
          </Card>

          <div className="relative min-h-0 flex-[2] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <ModelViewer
              parts={parts}
              selectedId={selectedPartId}
              onSelect={setSelectedPartId}
              bedSizeXMm={settings.bedSizeXMm}
              bedSizeYMm={settings.bedSizeYMm}
              overlappingIds={overlappingIds}
              pickFaceMode={pickFaceMode}
              onFacePicked={handleFacePicked}
              onPositionChange={(id, position) => handlePartChange(id, { position })}
            />
            {parts.length === 0 && !loadingFiles && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
                モデルをアップロードするとここに3Dプレートが表示されます
              </div>
            )}
            {parts.length > 0 && (
              <button
                onClick={() => setPickFaceMode((v) => !v)}
                className={`absolute left-3 top-3 rounded border px-3 py-1.5 text-xs backdrop-blur ${
                  pickFaceMode
                    ? "border-blue-500 bg-blue-600/80 text-white"
                    : "border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {pickFaceMode ? "面をクリックしてください (キャンセル)" : "面を選んで設置"}
              </button>
            )}
            {parts.length > 0 && !pickFaceMode && (
              <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-500 backdrop-blur">
                パーツをドラッグしてプレート上の位置をずらせます
              </div>
            )}
            {stlBlob && (
              <button
                onClick={downloadStl}
                className="absolute bottom-3 right-3 rounded border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur hover:bg-zinc-800"
              >
                プレートSTLをダウンロード
              </button>
            )}
          </div>

          {parts.length > 0 && (
            <Card className="max-h-[35%] flex-none overflow-y-auto">
              <h2 className="mb-2 text-sm font-semibold text-zinc-200">パーツ一覧・配置調整</h2>
              <PartList
                parts={parts}
                selectedId={selectedPartId}
                onSelect={setSelectedPartId}
                onChange={handlePartChange}
                onRemove={handleRemovePart}
                onDropToBed={handleDropToBed}
                overlappingIds={overlappingIds}
              />
            </Card>
          )}
        </section>

        {/* Right: tabbed slice / print panels */}
        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="mb-3 flex flex-none gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-sm">
            <TabButton active={rightTab === "slice"} onClick={() => setRightTab("slice")}>
              ② スライス
            </TabButton>
            <TabButton active={rightTab === "print"} onClick={() => setRightTab("print")}>
              ③ プリンターへ送信
            </TabButton>
          </div>

          <div className="flex-1 overflow-y-auto pr-1">
            {rightTab === "slice" && (
              <div className="flex flex-col gap-4">
                <Card>
                  <h2 className="mb-3 text-sm font-semibold text-zinc-200">スライス設定</h2>

                  <div className="mb-3">
                    <label className="flex flex-col gap-1 text-sm">
                      <span className="text-zinc-400">フィラメント</span>
                      <select
                        value={settings.filament}
                        onChange={(e) =>
                          setSettings((s) => applyFilamentProfile(s, e.target.value as FilamentId))
                        }
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-zinc-100"
                      >
                        {FILAMENT_PROFILES.map((f) => (
                          <option key={f.id} value={f.id}>{f.label}</option>
                        ))}
                      </select>
                    </label>
                    {!matchesFilamentProfile(settings) && (
                      <button
                        onClick={() => setSettings((s) => applyFilamentProfile(s, s.filament))}
                        className="mt-1.5 text-xs text-blue-400 hover:underline"
                      >
                        温度・速度を手動で変更中です。{getFilamentProfile(settings.filament).label}の推奨値に戻す
                      </button>
                    )}
                    {getFilamentProfile(settings.filament).warnings.map((warning) => (
                      <p
                        key={warning}
                        className="mt-1.5 rounded border border-amber-800 bg-amber-950/40 px-2 py-1 text-xs leading-relaxed text-amber-300"
                      >
                        ⚠️ {warning}
                      </p>
                    ))}
                    {getFilamentProfile(settings.filament).hints.map((hint) => (
                      <p key={hint} className="mt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <NumberField label="レイヤー高さ (mm)" value={settings.layerHeightMm} step={0.02}
                      onChange={(v) => setSettings((s) => ({ ...s, layerHeightMm: v }))} />
                    <NumberField label="壁の数" value={settings.wallLoops} step={1} min={1}
                      onChange={(v) => setSettings((s) => ({ ...s, wallLoops: Math.round(v) }))} />
                    <NumberField label="インフィル密度 (%)" value={settings.infillDensityPct} step={5} min={0} max={100}
                      onChange={(v) => setSettings((s) => ({ ...s, infillDensityPct: v }))} />
                    <label className="flex flex-col gap-1">
                      <span className="text-zinc-400">インフィルパターン</span>
                      <select
                        value={settings.infillPattern}
                        onChange={(e) =>
                          setSettings((s) => ({ ...s, infillPattern: e.target.value as InfillPattern }))
                        }
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-100"
                      >
                        {INFILL_PATTERNS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </label>
                    <NumberField label="上下ソリッド層" value={settings.topBottomLayers} step={1} min={0}
                      onChange={(v) => setSettings((s) => ({ ...s, topBottomLayers: Math.round(v) }))} />
                    <NumberField label="ノズル温度 (℃)" value={settings.nozzleTempC} step={5}
                      onChange={(v) => setSettings((s) => ({ ...s, nozzleTempC: v, firstLayerNozzleTempC: v }))} />
                    <NumberField label="ベッド温度 (℃)" value={settings.bedTempC} step={5}
                      onChange={(v) => setSettings((s) => ({ ...s, bedTempC: v }))} />
                    <NumberField label="印刷速度 (mm/s)" value={settings.printSpeedMmS} step={5}
                      onChange={(v) => setSettings((s) => ({ ...s, printSpeedMmS: v }))} />
                    <NumberField label="押出幅 (mm)" value={settings.extrusionWidthMm} step={0.02}
                      onChange={(v) => setSettings((s) => ({ ...s, extrusionWidthMm: v }))} />
                  </div>

                  <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                    {getInfillPattern(settings.infillPattern).description}
                  </p>

                  <div className="mt-4 border-t border-zinc-800 pt-3">
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        checked={settings.supportEnabled}
                        onChange={(e) => setSettings((s) => ({ ...s, supportEnabled: e.target.checked }))}
                      />
                      サポート材を自動生成する(ビルドプレート接地のみ)
                    </label>
                    {settings.supportEnabled && (
                      <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                        <NumberField label="オーバーハング角度 (°)" value={settings.supportOverhangAngleDeg} step={5} min={0} max={89}
                          onChange={(v) => setSettings((s) => ({ ...s, supportOverhangAngleDeg: v }))} />
                        <NumberField label="サポート間隔 (mm)" value={settings.supportSpacingMm} step={0.5} min={1}
                          onChange={(v) => setSettings((s) => ({ ...s, supportSpacingMm: v }))} />
                        <NumberField label="サポート柱サイズ (mm)" value={settings.supportPillarSizeMm} step={0.1} min={0.4}
                          onChange={(v) => setSettings((s) => ({ ...s, supportPillarSizeMm: v }))} />
                        <NumberField label="頂部クリアランス (mm)" value={settings.supportTopGapMm} step={0.05} min={0}
                          onChange={(v) => setSettings((s) => ({ ...s, supportTopGapMm: v }))} />
                      </div>
                    )}
                  </div>

                  {overlappingIds.size > 0 && (
                    <p className="mt-3 rounded border border-red-800 bg-red-950/40 px-2 py-1.5 text-xs text-red-300">
                      ⚠️ 左のプレートで {overlappingIds.size} パーツが重なっています。このままスライスすると重なった部分が二重に印刷されます。
                    </p>
                  )}
                  <button
                    disabled={!stlBlob || slicing}
                    onClick={handleSlice}
                    className="mt-4 w-full rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
                  >
                    {slicing ? "スライス中..." : "スライス実行"}
                  </button>
                  {sliceError && <p className="mt-2 text-sm text-red-400">{sliceError}</p>}
                  <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                    ※ 内蔵スライサーは単色・AMS非対応の簡易実装です。フル機能(AMS/フロー校正/専用開始Gコード)が必要な場合は、
                    Bambu Studio/OrcaSlicerで書き出した「.gcode.3mf」を「③ プリンターへ送信」タブから送信してください。
                    サポートは「ビルドプレート接地のみ」モードのみ対応しています。
                  </p>
                </Card>

                {stats && (
                  <Card>
                    <h2 className="mb-3 text-sm font-semibold text-zinc-200">スライス結果</h2>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-zinc-300">
                      <dt className="text-zinc-500">レイヤー数</dt>
                      <dd>{stats.layerCount}</dd>
                      <dt className="text-zinc-500">推定時間</dt>
                      <dd>{formatDuration(stats.estimatedTimeSec)}</dd>
                      <dt className="text-zinc-500">推定フィラメント長</dt>
                      <dd>{(stats.estimatedFilamentMm / 1000).toFixed(2)} m</dd>
                      <dt className="text-zinc-500">推定重量</dt>
                      <dd>{stats.estimatedFilamentGrams.toFixed(1)} g</dd>
                    </dl>
                    <div className="mt-4">
                      <ToolpathPreview
                        layers={toolpath}
                        bedSizeXMm={settings.bedSizeXMm}
                        bedSizeYMm={settings.bedSizeYMm}
                      />
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={downloadGcode}
                        className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                      >
                        Gコードをダウンロード
                      </button>
                      <button
                        onClick={() => setRightTab("print")}
                        className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
                      >
                        次へ: プリンターへ送信 →
                      </button>
                    </div>
                  </Card>
                )}
              </div>
            )}

            {rightTab === "print" && (
              <div className="flex flex-col gap-4">
                <Card>
                  <h2 className="mb-3 text-sm font-semibold text-zinc-200">プリンター接続 (Bambu Lab / LAN モード)</h2>
                  <PrinterProfiles
                    printers={savedPrinters}
                    activeId={activePrinterId}
                    onSelect={handleSelectSavedPrinter}
                    onSaveNew={handleSaveNewPrinter}
                    onUpdateActive={handleUpdateActivePrinter}
                    onRemove={handleRemoveSavedPrinter}
                  />
                  <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                    <TextField label="IPアドレス" value={printer.host} onChange={(v) => setPrinter((p) => ({ ...p, host: v }))} placeholder="192.168.1.50" />
                    <TextField label="シリアル番号" value={printer.serial} onChange={(v) => setPrinter((p) => ({ ...p, serial: v }))} placeholder="01P00A000000000" />
                    <TextField label="アクセスコード" value={printer.accessCode} onChange={(v) => setPrinter((p) => ({ ...p, accessCode: v }))} type="password" />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      disabled={statusLoading || !printer.host}
                      onClick={handleGetStatus}
                      className="rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600 disabled:opacity-50"
                    >
                      {statusLoading ? "確認中..." : "ステータス取得"}
                    </button>
                    <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                      自動更新 (5秒ごと)
                    </label>
                    <button onClick={() => handleControl("pause")} disabled={printBusy} className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50">一時停止</button>
                    <button onClick={() => handleControl("resume")} disabled={printBusy} className="rounded border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50">再開</button>
                    <button onClick={() => handleControl("stop")} disabled={printBusy} className="rounded border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50">停止</button>
                  </div>
                  {statusError && <p className="mt-2 text-sm text-red-400">{statusError}</p>}
                  {printerStatus && (
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
                      <dt className="text-zinc-500">状態</dt>
                      <dd>{printerStatus.status}</dd>
                      <dt className="text-zinc-500">ノズル温度</dt>
                      <dd>{printerStatus.temperatures?.nozzle?.actual}℃ / {printerStatus.temperatures?.nozzle?.target}℃</dd>
                      <dt className="text-zinc-500">ベッド温度</dt>
                      <dd>{printerStatus.temperatures?.bed?.actual}℃ / {printerStatus.temperatures?.bed?.target}℃</dd>
                      <dt className="text-zinc-500">進捗</dt>
                      <dd>{printerStatus.print?.progressPct}% (layer {printerStatus.print?.currentLayer}/{printerStatus.print?.totalLayers})</dd>
                    </dl>
                  )}
                </Card>

                <Card>
                  <h2 className="mb-3 text-sm font-semibold text-zinc-200">印刷方法</h2>
                  <div className="mb-3 flex gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-1 text-sm">
                    <TabButton small active={printMode === "gcode"} onClick={() => setPrintMode("gcode")}>
                      簡易Gコード
                    </TabButton>
                    <TabButton small active={printMode === "project"} onClick={() => setPrintMode("project")}>
                      3MFプロジェクト
                    </TabButton>
                  </div>

                  {printMode === "gcode" ? (
                    <div>
                      <p className="mb-3 text-xs text-zinc-500">
                        「② スライス」タブで生成したGコードをそのまま送信します。単色・AMSなし、P1・A1・X1系のみ対応。
                      </p>
                      <button
                        disabled={!gcode || printBusy || !printer.host}
                        onClick={handlePrintGcode}
                        className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
                      >
                        {printBusy ? "送信中..." : gcode ? "スライス結果を送信して印刷" : "先にスライスしてください"}
                      </button>
                    </div>
                  ) : (
                    <div>
                      <p className="mb-3 text-xs text-zinc-500">
                        Bambu Studio / OrcaSlicerで書き出した「.gcode.3mf」を送信します。AMSマッピングやフロー校正などはスライス時の設定がそのまま使われます(プリンター本体でファイルを開いた場合と同じ動作です)。
                      </p>
                      <input
                        type="file"
                        accept=".3mf"
                        onChange={(e) => setProjectFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-700 file:px-3 file:py-1.5 file:text-white hover:file:bg-zinc-600"
                      />
                      <button
                        disabled={!projectFile || printBusy || !printer.host}
                        onClick={handlePrintProject}
                        className="mt-3 w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
                      >
                        {printBusy ? "送信中..." : "3MFを送信して印刷"}
                      </button>
                    </div>
                  )}

                  {printMessage && <p className="mt-3 text-sm text-emerald-400">{printMessage}</p>}
                  {printErrorMsg && <p className="mt-3 text-sm text-red-400">{printErrorMsg}</p>}
                  <p className="mt-3 text-xs leading-relaxed text-zinc-500">
                    ※ H2シリーズ(H2S/H2D/H2C)は追加のクライアント証明書(mTLS)が必要なため本ツールは非対応です。P1/A1/X1系のLANモードを想定しています。
                  </p>
                </Card>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>{children}</div>;
}

function TabButton({
  active,
  onClick,
  children,
  small = false,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md font-medium transition-colors ${small ? "px-2 py-1 text-xs" : "px-3 py-1.5"} ${
        active ? "bg-blue-600 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function StepBadge({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <li
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
        active ? "bg-blue-600/20 text-blue-300" : done ? "text-emerald-400" : "text-zinc-500"
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
          active ? "bg-blue-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className="hidden sm:inline">{label}</span>
    </li>
  );
}

function StepArrow() {
  return <span className="text-zinc-700">→</span>;
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-100"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-zinc-400">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-100"
      />
    </label>
  );
}
