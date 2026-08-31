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

export interface SliceSettings {
  layerHeightMm: number;
  firstLayerHeightMm: number;
  nozzleDiameterMm: number;
  filamentDiameterMm: number;
  extrusionWidthMm: number;
  wallLoops: number;
  topBottomLayers: number;
  infillDensityPct: number; // 0-100
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
};

export interface LayerPaths {
  z: number;
  layerHeight: number;
  perimeters: Loop[][]; // per original loop: list of inset loops (outer -> inner)
  infill: [Vec2, Vec2][]; // line segments
  solid: [Vec2, Vec2][]; // top/bottom solid fill segments
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
