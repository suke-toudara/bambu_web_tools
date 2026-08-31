import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { ftpUpload } from "./ftp";
import { publishPrintCommand } from "./mqtt";
import type { BambuConnection } from "./types";

/**
 * Uploads a plain single-filament .gcode file and starts it via the
 * `gcode_file` MQTT command. This is the well-documented path for P1/A1/X1
 * series LAN mode. It is NOT supported on H2-series printers (H2 requires
 * `project_file` + a Bambu-issued mTLS client certificate, which this tool
 * does not implement) and does not use the AMS.
 */
export async function printGcodeFile(
  conn: BambuConnection,
  gcode: string,
  fileName: string
): Promise<{ remotePath: string }> {
  const safeName = sanitizeFileName(fileName, ".gcode");
  const remotePath = `cache/${safeName}`;
  await ftpUpload(conn, Buffer.from(gcode, "utf8"), `/${remotePath}`);
  await publishPrintCommand(conn, {
    command: "gcode_file",
    param: remotePath,
  });
  return { remotePath };
}

export interface PrintProjectOptions {
  useAms: boolean;
  bedType?: string;
  timelapse?: boolean;
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
}

/**
 * Uploads a pre-sliced `.gcode.3mf` (exported from Bambu Studio / OrcaSlicer
 * via "Export plate sliced file") and starts it via the `project_file` MQTT
 * command. This is the recommended path for full-featured Bambu prints
 * (correct vendor start gcode, calibration, and — with useAms — AMS
 * filament mapping). P1/A1/X1 series only; H2-series is not supported (see
 * printGcodeFile doc).
 */
export async function printProjectFile(
  conn: BambuConnection,
  fileBuffer: Buffer,
  fileName: string,
  options: PrintProjectOptions
): Promise<{ remotePath: string; plateFile: string; amsMapping: number[] }> {
  const safeName = sanitizeFileName(fileName, ".3mf");
  const remotePath = `cache/${safeName}`;

  const zip = await JSZip.loadAsync(fileBuffer);
  const plateEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && /^Metadata\/plate_\d+\.gcode$/i.test(entry.name)
  );
  if (plateEntries.length === 0) {
    throw new Error(
      "This .3mf does not contain a sliced plate (Metadata/plate_<n>.gcode). Export via 'File > Export > Export plate sliced file' in Bambu Studio/OrcaSlicer, not a plain model export."
    );
  }
  const plateEntry = plateEntries.sort((a, b) => a.name.localeCompare(b.name))[0];
  const gcodeBuffer = await plateEntry.async("nodebuffer");
  const md5 = createHash("md5").update(gcodeBuffer).digest("hex");

  let usedFilamentPositions: number[] = [0];
  const plateJsonEntry = zip.file(plateEntry.name.replace(/\.gcode$/i, ".json"));
  if (plateJsonEntry) {
    try {
      const json = JSON.parse(await plateJsonEntry.async("string"));
      if (Array.isArray(json.filament_ids) && json.filament_ids.length > 0) {
        usedFilamentPositions = json.filament_ids.filter((n: unknown) => Number.isInteger(n));
      }
    } catch {
      // tolerate malformed plate json; fall back to default position [0]
    }
  }

  const amsMapping = new Array(5).fill(-1);
  if (options.useAms) {
    usedFilamentPositions.forEach((pos, i) => {
      if (pos < amsMapping.length) amsMapping[pos] = i;
    });
  }

  await ftpUpload(conn, fileBuffer, `/${remotePath}`);

  await publishPrintCommand(conn, {
    command: "project_file",
    param: `Metadata/${path.posix.basename(plateEntry.name)}`,
    url: `file:///sdcard/${remotePath}`,
    subtask_name: safeName.replace(/\.3mf$/i, ""),
    md5,
    flow_cali: options.flowCalibration ?? true,
    layer_inspect: false,
    vibration_cali: options.vibrationCalibration ?? true,
    bed_leveling: options.bedLeveling ?? true,
    bed_type: options.bedType || "textured_plate",
    timelapse: options.timelapse ?? false,
    use_ams: options.useAms,
    ams_mapping: amsMapping,
    profile_id: "0",
    project_id: "0",
    subtask_id: "0",
    task_id: "0",
  });

  return { remotePath, plateFile: plateEntry.name, amsMapping };
}

export async function sendControl(conn: BambuConnection, action: "pause" | "resume" | "stop"): Promise<void> {
  await publishPrintCommand(conn, { command: action });
}

function sanitizeFileName(name: string, requiredExt: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const withExt = base.toLowerCase().endsWith(requiredExt) ? base : `${base}${requiredExt}`;
  return withExt || `model${requiredExt}`;
}
