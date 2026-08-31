"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { parseStepFile, type OcctMesh } from "@/lib/occt/loadStep";
import { mergeMeshesToTriangleSoup } from "@/lib/occt/mergeMeshes";
import { meshToBinaryStl } from "@/lib/stl/exportBinaryStl";
import { DEFAULT_SLICE_SETTINGS, type SliceSettings } from "@/lib/slicer/types";
import type { LayerPreviewData } from "@/components/LayerPreview";

const ModelViewer = dynamic(() => import("@/components/ModelViewer"), { ssr: false });
const LayerPreview = dynamic(() => import("@/components/LayerPreview"), { ssr: false });

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

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Home() {
  const [meshes, setMeshes] = useState<OcctMesh[] | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [settings, setSettings] = useState<SliceSettings>(DEFAULT_SLICE_SETTINGS);
  const [slicing, setSlicing] = useState(false);
  const [sliceError, setSliceError] = useState<string | null>(null);
  const [gcode, setGcode] = useState<string | null>(null);
  const [stats, setStats] = useState<SliceStats | null>(null);
  const [layerPreview, setLayerPreview] = useState<LayerPreviewData[]>([]);

  const [printer, setPrinter] = useState<PrinterConn>({ host: "", serial: "", accessCode: "" });
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [printerStatus, setPrinterStatus] = useState<any>(null);

  const [printBusy, setPrintBusy] = useState(false);
  const [printMessage, setPrintMessage] = useState<string | null>(null);
  const [printErrorMsg, setPrintErrorMsg] = useState<string | null>(null);

  const [useAms, setUseAms] = useState(false);
  const [projectFile, setProjectFile] = useState<File | null>(null);

  const [rightTab, setRightTab] = useState<"slice" | "print">("slice");
  const [printMode, setPrintMode] = useState<"gcode" | "project">("gcode");

  useEffect(() => {
    // One-time hydration of persisted printer settings from localStorage.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setPrinter(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(printer));
    } catch {
      // ignore
    }
  }, [printer]);

  const stlBlob = useMemo(() => {
    if (!meshes || meshes.length === 0) return null;
    const soup = mergeMeshesToTriangleSoup(meshes);
    return meshToBinaryStl(soup, null);
  }, [meshes]);

  async function handleFile(file: File) {
    setParseError(null);
    setParsing(true);
    setMeshes(null);
    setGcode(null);
    setStats(null);
    setLayerPreview([]);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const result = await parseStepFile(buffer);
      setMeshes(result.meshes);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Failed to parse STEP file.");
    } finally {
      setParsing(false);
    }
  }

  async function handleSlice() {
    if (!stlBlob) return;
    setSlicing(true);
    setSliceError(null);
    setGcode(null);
    setStats(null);
    setLayerPreview([]);
    try {
      const form = new FormData();
      form.append("file", stlBlob, "model.stl");
      form.append("settings", JSON.stringify(settings));
      const res = await fetch("/api/slice", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Slicing failed.");
      setGcode(data.gcode);
      setStats(data.stats);
      setLayerPreview(data.layerPreview);
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
    a.download = (fileName.replace(/\.(step|stp)$/i, "") || "model") + ".gcode";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadStl() {
    if (!stlBlob) return;
    const url = URL.createObjectURL(stlBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (fileName.replace(/\.(step|stp)$/i, "") || "model") + ".stl";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleGetStatus() {
    setStatusLoading(true);
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
    } finally {
      setStatusLoading(false);
    }
  }

  async function handlePrintGcode() {
    if (!gcode) return;
    setPrintBusy(true);
    setPrintMessage(null);
    setPrintErrorMsg(null);
    try {
      const res = await fetch("/api/printer/print-gcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...printer, gcode, fileName: (fileName || "model") + ".gcode" }),
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
      form.append("options", JSON.stringify({ useAms }));
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

  const step = !meshes ? 1 : !stats ? 2 : 3;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Bambu Web Tools</h1>
          <p className="text-xs text-zinc-500">STEP表示・スライス・Bambuプリンター印刷</p>
        </div>
        <ol className="flex items-center gap-2 text-xs text-zinc-400">
          <StepBadge n={1} label="アップロード" active={step === 1} done={step > 1} />
          <StepArrow />
          <StepBadge n={2} label="スライス" active={step === 2} done={step > 2} />
          <StepArrow />
          <StepBadge n={3} label="印刷" active={step === 3} done={false} />
        </ol>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Left: upload + viewer, fills available height */}
        <section className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <Card className="flex-none">
            <label className="mb-1 block text-sm font-medium text-zinc-300">
              1. STEPファイルを選択 (.step / .stp)
            </label>
            <input
              type="file"
              accept=".step,.stp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
              className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-white hover:file:bg-blue-500"
            />
            {parsing && <p className="mt-2 text-sm text-amber-400">STEPファイルを解析中...</p>}
            {parseError && <p className="mt-2 text-sm text-red-400">{parseError}</p>}
            {meshes && !parsing && (
              <p className="mt-2 truncate text-sm text-emerald-400">
                {fileName}: {meshes.length} パーツを読み込みました
              </p>
            )}
          </Card>

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <ModelViewer meshes={meshes} />
            {!meshes && !parsing && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
                STEPファイルをアップロードするとここに3Dモデルが表示されます
              </div>
            )}
            {stlBlob && (
              <button
                onClick={downloadStl}
                className="absolute bottom-3 right-3 rounded border border-zinc-700 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur hover:bg-zinc-800"
              >
                STLをダウンロード
              </button>
            )}
          </div>
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
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <NumberField label="レイヤー高さ (mm)" value={settings.layerHeightMm} step={0.02}
                      onChange={(v) => setSettings((s) => ({ ...s, layerHeightMm: v }))} />
                    <NumberField label="壁の数" value={settings.wallLoops} step={1} min={1}
                      onChange={(v) => setSettings((s) => ({ ...s, wallLoops: Math.round(v) }))} />
                    <NumberField label="インフィル密度 (%)" value={settings.infillDensityPct} step={5} min={0} max={100}
                      onChange={(v) => setSettings((s) => ({ ...s, infillDensityPct: v }))} />
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
                      <LayerPreview layers={layerPreview} />
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
                        Bambu Studio / OrcaSlicerで書き出した「.gcode.3mf」を送信します。AMS・フロー校正などフル機能に対応。
                      </p>
                      <input
                        type="file"
                        accept=".3mf"
                        onChange={(e) => setProjectFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded file:border-0 file:bg-zinc-700 file:px-3 file:py-1.5 file:text-white hover:file:bg-zinc-600"
                      />
                      <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
                        <input type="checkbox" checked={useAms} onChange={(e) => setUseAms(e.target.checked)} />
                        AMSを使用する
                      </label>
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
