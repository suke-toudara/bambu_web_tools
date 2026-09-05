import type { FilamentId, SliceSettings } from "./types";

export type { FilamentId };

export interface FilamentProfile {
  id: FilamentId;
  label: string;
  /** Material name written into the gcode's CONFIG_BLOCK. */
  gcodeType: string;
  /** g/cm^3 — drives the filament weight estimate, which was previously
   * hard-coded to PLA regardless of what you actually print with. */
  densityGCm3: number;
  nozzleTempC: number;
  firstLayerNozzleTempC: number;
  bedTempC: number;
  fanSpeedPct: number;
  printSpeedMmS: number;
  firstLayerSpeedMmS: number;
  retractionMm: number;
  retractionSpeedMmS: number;
  /** Things that will bite you on an open-frame A1 / A1 mini specifically. */
  warnings: string[];
  hints: string[];
}

/**
 * Starting points for the built-in slicer, in the ballpark of the vendor
 * profiles for the A1 family (open frame, direct drive, textured PEI plate).
 * They are deliberately more conservative on speed than Bambu Studio's own
 * profiles: this slicer emits no acceleration/jerk control and no vendor
 * start gcode, so the printer's own motion planner is doing all the work.
 */
export const FILAMENT_PROFILES: FilamentProfile[] = [
  {
    id: "pla",
    label: "PLA",
    gcodeType: "PLA",
    densityGCm3: 1.24,
    nozzleTempC: 220,
    firstLayerNozzleTempC: 220,
    bedTempC: 60,
    fanSpeedPct: 100,
    printSpeedMmS: 60,
    firstLayerSpeedMmS: 20,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: [],
    hints: ["最も扱いやすい材料です。迷ったらこれで問題ありません。"],
  },
  {
    id: "pla-cf",
    label: "PLA-CF (カーボン繊維入り)",
    gcodeType: "PLA-CF",
    densityGCm3: 1.24,
    nozzleTempC: 230,
    firstLayerNozzleTempC: 230,
    bedTempC: 60,
    fanSpeedPct: 100,
    printSpeedMmS: 50,
    firstLayerSpeedMmS: 20,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: ["硬化スチールノズルが必須です。標準ノズルは繊維で急速に摩耗します。"],
    hints: ["マット質感になり、反りはPLAより少なめです。"],
  },
  {
    id: "petg",
    label: "PETG",
    gcodeType: "PETG",
    densityGCm3: 1.27,
    nozzleTempC: 255,
    firstLayerNozzleTempC: 255,
    bedTempC: 70,
    fanSpeedPct: 50,
    printSpeedMmS: 50,
    firstLayerSpeedMmS: 20,
    retractionMm: 1.0,
    retractionSpeedMmS: 30,
    warnings: [],
    hints: [
      "糸引きしやすいので、リトラクションと速度は控えめにしています。",
      "ビルドプレートに強く食いつきます。剥がれない場合は完全に冷ましてください。",
    ],
  },
  {
    id: "petg-cf",
    label: "PETG-CF (カーボン繊維入り)",
    gcodeType: "PETG-CF",
    densityGCm3: 1.3,
    nozzleTempC: 260,
    firstLayerNozzleTempC: 260,
    bedTempC: 70,
    fanSpeedPct: 50,
    printSpeedMmS: 45,
    firstLayerSpeedMmS: 20,
    retractionMm: 1.0,
    retractionSpeedMmS: 30,
    warnings: ["硬化スチールノズルが必須です。"],
    hints: ["要乾燥。吸湿すると表面が荒れます。"],
  },
  {
    id: "tpu95a",
    label: "TPU 95A (軟質)",
    gcodeType: "TPU",
    densityGCm3: 1.21,
    nozzleTempC: 230,
    firstLayerNozzleTempC: 230,
    bedTempC: 40,
    fanSpeedPct: 100,
    printSpeedMmS: 25,
    firstLayerSpeedMmS: 15,
    retractionMm: 0.4,
    retractionSpeedMmS: 20,
    warnings: ["AMSは使用できません。外部スプールから直接送ってください。"],
    hints: [
      "低速・低リトラクションが必須のため、速度を大きく落としています。",
      "インフィル密度は5〜15%程度が扱いやすいです。",
    ],
  },
  {
    id: "abs",
    label: "ABS",
    gcodeType: "ABS",
    densityGCm3: 1.04,
    nozzleTempC: 260,
    firstLayerNozzleTempC: 260,
    bedTempC: 90,
    fanSpeedPct: 15,
    printSpeedMmS: 50,
    firstLayerSpeedMmS: 20,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: [
      "A1 / A1 mini はオープンフレームです。大きい造形物は反り・層間剥離が起きやすく、囲い(エンクロージャ)が実質必要です。",
      "換気してください。",
    ],
    hints: ["冷却をほぼ切っているのは、急冷が反りの主因になるためです。"],
  },
  {
    id: "asa",
    label: "ASA",
    gcodeType: "ASA",
    densityGCm3: 1.07,
    nozzleTempC: 260,
    firstLayerNozzleTempC: 260,
    bedTempC: 90,
    fanSpeedPct: 10,
    printSpeedMmS: 50,
    firstLayerSpeedMmS: 20,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: [
      "A1 / A1 mini はオープンフレームです。ABS同様、囲いなしでは大物の反りが避けにくい材料です。",
      "換気してください。",
    ],
    hints: ["耐候性が高く屋外向けです。"],
  },
  {
    id: "pc",
    label: "PC (ポリカーボネート)",
    gcodeType: "PC",
    densityGCm3: 1.19,
    nozzleTempC: 270,
    firstLayerNozzleTempC: 270,
    bedTempC: 100,
    fanSpeedPct: 10,
    printSpeedMmS: 45,
    firstLayerSpeedMmS: 15,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: [
      "囲いなしのA1系では反りが強く出ます。小物向けと考えてください。",
      "要乾燥。吸湿していると気泡だらけになります。",
    ],
    hints: [],
  },
  {
    id: "pa-cf",
    label: "PA-CF (ナイロン・カーボン繊維入り)",
    gcodeType: "PA-CF",
    densityGCm3: 1.06,
    nozzleTempC: 290,
    firstLayerNozzleTempC: 290,
    bedTempC: 100,
    fanSpeedPct: 20,
    printSpeedMmS: 45,
    firstLayerSpeedMmS: 15,
    retractionMm: 0.8,
    retractionSpeedMmS: 30,
    warnings: [
      "硬化スチールノズルが必須です。",
      "非常に吸湿しやすい材料です。印刷直前まで乾燥させてください。",
      "A1系の最高ノズル温度に近いため、機種の対応温度を確認してください。",
    ],
    hints: [],
  },
];

export const DEFAULT_FILAMENT_ID: FilamentId = "pla";

export function getFilamentProfile(id: FilamentId): FilamentProfile {
  return FILAMENT_PROFILES.find((f) => f.id === id) ?? FILAMENT_PROFILES[0];
}

/**
 * Returns `settings` with every material-dependent value replaced by the
 * profile's. Geometry settings (layer height, walls, infill density and
 * pattern, bed size, supports) are deliberately left alone — those are the
 * user's choices, not the filament's.
 */
export function applyFilamentProfile(settings: SliceSettings, id: FilamentId): SliceSettings {
  const p = getFilamentProfile(id);
  return {
    ...settings,
    filament: p.id,
    filamentDensityGCm3: p.densityGCm3,
    nozzleTempC: p.nozzleTempC,
    firstLayerNozzleTempC: p.firstLayerNozzleTempC,
    bedTempC: p.bedTempC,
    fanSpeedPct: p.fanSpeedPct,
    printSpeedMmS: p.printSpeedMmS,
    firstLayerSpeedMmS: p.firstLayerSpeedMmS,
    retractionMm: p.retractionMm,
    retractionSpeedMmS: p.retractionSpeedMmS,
  };
}

/** True when `settings` still matches the profile it claims to use, so the UI
 * can tell "PLA" from "PLA, but edited". */
export function matchesFilamentProfile(settings: SliceSettings): boolean {
  const p = getFilamentProfile(settings.filament);
  return (
    settings.nozzleTempC === p.nozzleTempC &&
    settings.firstLayerNozzleTempC === p.firstLayerNozzleTempC &&
    settings.bedTempC === p.bedTempC &&
    settings.fanSpeedPct === p.fanSpeedPct &&
    settings.printSpeedMmS === p.printSpeedMmS &&
    settings.firstLayerSpeedMmS === p.firstLayerSpeedMmS &&
    settings.retractionMm === p.retractionMm &&
    settings.retractionSpeedMmS === p.retractionSpeedMmS
  );
}
