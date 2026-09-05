import type { Loop, SliceResult, SliceSettings, Vec2 } from "./types";
import { getFilamentProfile } from "./filaments";

class GcodeWriter {
  private lines: string[] = [];
  push(line: string) {
    this.lines.push(line);
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
}

function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

/** Bambu Lab firmware validates that an uploaded .gcode file has the
 * HEADER_BLOCK / CONFIG_BLOCK / EXECUTABLE_BLOCK structure that Bambu
 * Studio/OrcaSlicer emit before it will accept a `gcode_file` MQTT command
 * ("MQTTコマンドの検証に失敗しました" on the printer screen otherwise); a
 * plain Marlin-style file without these markers is rejected outright. This
 * writes best-effort header/config blocks (reverse-engineered from
 * community documentation, not an official spec) around the actual moves so
 * the file matches the shape the firmware expects. */
function writeHeaderBlock(w: GcodeWriter, result: SliceResult, settings: SliceSettings): void {
  const filamentArea = Math.PI * (settings.filamentDiameterMm / 2) ** 2;
  const filamentVolumeCm3 = (result.estimatedFilamentMm * filamentArea) / 1000;
  const maxZ = result.boundsMax.z - result.boundsMin.z;
  const filament = getFilamentProfile(settings.filament);

  w.push("; HEADER_BLOCK_START");
  w.push("; BambuStudio 01.09.00.63");
  w.push(`; model printing time: ${formatDuration(result.estimatedTimeSec)}`);
  w.push(`; total estimated time: ${formatDuration(result.estimatedTimeSec)}`);
  w.push(`; total layer number: ${result.layerCount}`);
  w.push(`; total filament length [mm] : ${result.estimatedFilamentMm.toFixed(2)}`);
  w.push(`; total filament volume [cm^3] : ${filamentVolumeCm3.toFixed(2)}`);
  w.push(`; total filament weight [g] : ${result.estimatedFilamentGrams.toFixed(2)}`);
  w.push(`; filament_density : ${filament.densityGCm3}`);
  w.push(`; filament_diameter : ${settings.filamentDiameterMm}`);
  w.push(`; max_z_height : ${maxZ.toFixed(2)}`);
  w.push("; HEADER_BLOCK_END");
  w.push(";");
  w.push("; CONFIG_BLOCK_START");
  w.push(`; nozzle_diameter = ${settings.nozzleDiameterMm}`);
  w.push(`; layer_height = ${settings.layerHeightMm}`);
  w.push(`; initial_layer_height = ${settings.firstLayerHeightMm}`);
  w.push(`; line_width = ${settings.extrusionWidthMm}`);
  w.push(`; wall_loops = ${settings.wallLoops}`);
  w.push(`; sparse_infill_density = ${settings.infillDensityPct}%`);
  w.push(`; sparse_infill_pattern = ${settings.infillPattern}`);
  w.push(`; outer_wall_speed = ${settings.printSpeedMmS}`);
  w.push(`; initial_layer_speed = ${settings.firstLayerSpeedMmS}`);
  w.push(`; travel_speed = ${settings.travelSpeedMmS}`);
  w.push(`; nozzle_temperature = ${settings.nozzleTempC}`);
  w.push(`; nozzle_temperature_initial_layer = ${settings.firstLayerNozzleTempC}`);
  w.push(`; bed_temperature = ${settings.bedTempC}`);
  w.push(`; hot_plate_temp = ${settings.bedTempC}`);
  w.push(`; fan_max_speed = ${settings.fanSpeedPct}`);
  w.push(`; filament_type = ${filament.gcodeType}`);
  w.push("; CONFIG_BLOCK_END");
  w.push(";");
}

/** Generates plain FDM gcode (Marlin/Klipper dialect, works as a generic
 * single-filament "gcode_file" style print on Bambu P1/A1/X1 series, and on
 * OctoPrint/Klipper/Prusa hosts). This is a simplified hobbyist-level
 * slicer output: no vendor calibration macros, no AMS/multi-material, no
 * adaptive layers. For production-quality Bambu prints (AMS, flow
 * calibration, per-model start gcode) pre-slice in Bambu Studio/OrcaSlicer
 * and use the "Upload pre-sliced .gcode.3mf" path instead. */
export function generateGcode(result: SliceResult, settings: SliceSettings): string {
  const w = new GcodeWriter();
  writeHeaderBlock(w, result, settings);
  w.push("; EXECUTABLE_BLOCK_START");

  const centerX = settings.bedSizeXMm / 2;
  const centerY = settings.bedSizeYMm / 2;
  const modelCenterX = (result.boundsMin.x + result.boundsMax.x) / 2;
  const modelCenterY = (result.boundsMin.y + result.boundsMax.y) / 2;
  const offsetX = centerX - modelCenterX;
  const offsetY = centerY - modelCenterY;

  const filamentArea = Math.PI * (settings.filamentDiameterMm / 2) ** 2;
  let e = 0;
  let currentSpeedMmMin = -1;
  let retracted = false;

  const setSpeed = (mmS: number) => {
    const mmMin = Math.round(mmS * 60);
    currentSpeedMmMin = mmMin;
  };

  const moveTo = (p: Vec2, extruding: boolean, feedMmS?: number) => {
    if (feedMmS) setSpeed(feedMmS);
    const parts = [`X${p.x.toFixed(3)}`, `Y${p.y.toFixed(3)}`];
    if (extruding) {
      parts.push(`E${e.toFixed(4)}`);
    }
    w.push(`G1 ${parts.join(" ")} F${currentSpeedMmMin}`);
  };

  const travelTo = (p: Vec2, feedMmS: number) => {
    if (!retracted) {
      w.push(`G1 E${(e - settings.retractionMm).toFixed(4)} F${Math.round(settings.retractionSpeedMmS * 60)}`);
      retracted = true;
    }
    setSpeed(feedMmS);
    w.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} F${currentSpeedMmMin}`);
  };

  const unretractIfNeeded = () => {
    if (retracted) {
      e += settings.retractionMm;
      w.push(`G1 E${e.toFixed(4)} F${Math.round(settings.retractionSpeedMmS * 60)}`);
      retracted = false;
    }
  };

  const extrudeSegment = (p1: Vec2, p2: Vec2, layerH: number, feedMmS: number) => {
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (len < 1e-6) return;
    const volumeMm3 = len * settings.extrusionWidthMm * layerH;
    e += volumeMm3 / filamentArea;
    moveTo(p2, true, feedMmS);
  };

  const printLoop = (loop: Loop, offset: Vec2, layerH: number, feedMmS: number) => {
    if (loop.length < 3) return;
    const start = { x: loop[0].x + offset.x, y: loop[0].y + offset.y };
    travelTo(start, settings.travelSpeedMmS);
    unretractIfNeeded();
    setSpeed(feedMmS);
    let prev = start;
    for (let i = 1; i <= loop.length; i++) {
      const raw = loop[i % loop.length];
      const p = { x: raw.x + offset.x, y: raw.y + offset.y };
      extrudeSegment(prev, p, layerH, feedMmS);
      prev = p;
    }
  };

  const printSegments = (segs: [Vec2, Vec2][], offset: Vec2, layerH: number, feedMmS: number) => {
    // Infill generators emit chained runs (see chainSegments): when a segment
    // starts where the previous one ended, keep extruding straight through
    // instead of retracting and travelling. Without this, a gyroid or
    // honeycomb layer costs one retract per short segment — thousands per
    // layer — which is both painfully slow and a stringing machine.
    let cursor: Vec2 | null = null;
    for (const [a, b] of segs) {
      const pa = { x: a.x + offset.x, y: a.y + offset.y };
      const pb = { x: b.x + offset.x, y: b.y + offset.y };
      if (!cursor || Math.hypot(cursor.x - pa.x, cursor.y - pa.y) > 1e-3) {
        travelTo(pa, settings.travelSpeedMmS);
        unretractIfNeeded();
      }
      extrudeSegment(pa, pb, layerH, feedMmS);
      cursor = pb;
    }
  };

  // --- Start gcode ---
  w.push("; Generated by bambu_web_tools basic slicer");
  w.push("; NOTE: single-filament, no AMS, no vendor calibration macros.");
  w.push(`M140 S${settings.bedTempC}`);
  w.push(`M104 S${settings.firstLayerNozzleTempC}`);
  w.push(`M190 S${settings.bedTempC}`);
  w.push(`M109 S${settings.firstLayerNozzleTempC}`);
  w.push("G28 ; home all axes");
  w.push("G90 ; absolute positioning");
  w.push("M82 ; absolute extrusion");
  w.push("G92 E0");
  w.push(`M106 S0`);

  const offset: Vec2 = { x: offsetX, y: offsetY };
  let z = 0;

  result.layers.forEach((layer, i) => {
    z += layer.layerHeight;
    w.push(`; LAYER ${i} z=${z.toFixed(3)}`);
    w.push(`G1 Z${z.toFixed(3)} F600`);

    if (i === 1) {
      w.push(`M104 S${settings.nozzleTempC}`);
      w.push(`M106 S${Math.round((settings.fanSpeedPct / 100) * 255)}`);
    }

    const feed = i === 0 ? settings.firstLayerSpeedMmS : settings.printSpeedMmS;

    for (const insets of layer.perimeters) {
      // Print innermost-to-outermost so outer wall quality isn't marred by
      // travel moves crossing already-printed inner walls.
      for (let k = insets.length - 1; k >= 0; k--) {
        printLoop(insets[k], offset, layer.layerHeight, feed);
      }
    }
    printSegments(layer.solid, offset, layer.layerHeight, feed);
    printSegments(layer.infill, offset, layer.layerHeight, feed);

    for (const insets of layer.supports) {
      for (let k = insets.length - 1; k >= 0; k--) {
        printLoop(insets[k], offset, layer.layerHeight, feed);
      }
    }
  });

  // --- End gcode ---
  w.push("; end of print");
  w.push(`G1 E${(e - settings.retractionMm).toFixed(4)} F${Math.round(settings.retractionSpeedMmS * 60)}`);
  w.push(`M104 S0`);
  w.push(`M140 S0`);
  w.push(`M106 S0`);
  w.push(`G91`);
  w.push(`G1 Z5 F600`);
  w.push(`G90`);
  w.push(`G1 X${centerX.toFixed(1)} Y${settings.bedSizeYMm.toFixed(1)} F6000`);
  w.push(`M84 ; disable motors`);
  w.push("; EXECUTABLE_BLOCK_END");

  return w.toString();
}
