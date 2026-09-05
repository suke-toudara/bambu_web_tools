export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

/** A closed polygon loop in a single Z layer. Orientation matters: walking the
 * loop in array order, the solid material is always to the LEFT of travel
 * direction (this falls out naturally from the triangle/plane intersection
 * order, for both outer boundaries (CCW) and holes (CW)). */
export type Loop = Vec2[];

/** Identifies a material preset in `slicer/filaments.ts`. */
export type FilamentId =
  | "pla"
  | "pla-cf"
  | "petg"
  | "petg-cf"
  | "tpu95a"
  | "abs"
  | "asa"
  | "pc"
  | "pa-cf";

/** How sparse infill is laid down. See `slicer/infill.ts`. */
export type InfillPattern =
  | "lines"
  | "grid"
  | "triangles"
  | "cubic"
  | "concentric"
  | "honeycomb"
  | "gyroid";

export interface SliceSettings {
  layerHeightMm: number;
  firstLayerHeightMm: number;
  nozzleDiameterMm: number;
  filamentDiameterMm: number;
  extrusionWidthMm: number;
  wallLoops: number;
  topBottomLayers: number;
  infillDensityPct: number; // 0-100
  infillPattern: InfillPattern;
  /** Material preset in use; drives temperatures, speeds and density. */
  filament: FilamentId;
  /** g/cm^3 for the selected material, used for the weight estimate. */
  filamentDensityGCm3: number;
  printSpeedMmS: number;
  firstLayerSpeedMmS: number;
  travelSpeedMmS: number;
  nozzleTempC: number;
  firstLayerNozzleTempC: number;
  bedTempC: number;
  fanSpeedPct: number;
  retractionMm: number;
  retractionSpeedMmS: number;
  bedSizeXMm: number;
  bedSizeYMm: number;
  supportEnabled: boolean;
  /** Max angle (degrees) from vertical a surface can lean before it's
   * considered an unsupported overhang. 0 = only flat ceilings get
   * support, 90 = everything (including vertical walls) would. */
  supportOverhangAngleDeg: number;
  /** Grid spacing (mm) between support pillars. */
  supportSpacingMm: number;
  /** Square cross-section size (mm) of each support pillar. */
  supportPillarSizeMm: number;
  /** Vertical gap (mm) left between a pillar's top and the overhang it
   * holds up, so the support can be snapped off cleanly. */
  supportTopGapMm: number;
}

export const DEFAULT_SLICE_SETTINGS: SliceSettings = {
  layerHeightMm: 0.2,
  firstLayerHeightMm: 0.2,
  nozzleDiameterMm: 0.4,
  filamentDiameterMm: 1.75,
  extrusionWidthMm: 0.42,
  wallLoops: 2,
  topBottomLayers: 3,
  infillDensityPct: 15,
  infillPattern: "grid",
  filament: "pla",
  filamentDensityGCm3: 1.24,
  printSpeedMmS: 60,
  firstLayerSpeedMmS: 20,
  travelSpeedMmS: 150,
  nozzleTempC: 220,
  firstLayerNozzleTempC: 220,
  bedTempC: 60,
  fanSpeedPct: 100,
  retractionMm: 0.8,
  retractionSpeedMmS: 35,
  bedSizeXMm: 256,
  bedSizeYMm: 256,
  supportEnabled: false,
  supportOverhangAngleDeg: 45,
  supportSpacingMm: 4,
  supportPillarSizeMm: 1.6,
  supportTopGapMm: 0.2,
};

export interface LayerPaths {
  z: number;
  layerHeight: number;
  perimeters: Loop[][]; // per original loop: list of inset loops (outer -> inner)
  infill: [Vec2, Vec2][]; // line segments
  solid: [Vec2, Vec2][]; // top/bottom solid fill segments
  supports: Loop[][]; // per support pillar: list of inset loops (same shape as perimeters)
}

export interface SupportPillar {
  x: number;
  y: number;
  /** Height (mm) the pillar reaches up to, measured from the build plate. */
  topZ: number;
}

export interface SliceResult {
  layers: LayerPaths[];
  boundsMin: Vec3;
  boundsMax: Vec3;
  estimatedTimeSec: number;
  estimatedFilamentMm: number;
  estimatedFilamentGrams: number;
  layerCount: number;
}
