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

/**
 * Uploads a pre-sliced `.gcode.3mf` (exported from Bambu Studio / OrcaSlicer
 * via "Export plate sliced file") and starts it via the `gcode_file` MQTT
 * command, the same way opening the file from the printer's own touchscreen
 * would. On P1/A1/X1 firmware, the `project_file` command — despite being
 * the one Bambu Studio/OrcaSlicer use themselves — is rejected for this
 * container with error 405004002 ("firmware doesn't recognise the
 * container"); `project_file` only works on H2-series printers, which this
 * tool does not support (see printGcodeFile doc). Because the printer opens
 * the container itself, AMS filament mapping, bed leveling, and calibration
 * are whatever was baked in at slice time / configured on the printer, not
 * something this command can override.
 */
export async function printProjectFile(
  conn: BambuConnection,
  fileBuffer: Buffer,
  fileName: string
): Promise<{ remotePath: string; plateFile: string }> {
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

  await ftpUpload(conn, fileBuffer, `/${remotePath}`);

  await publishPrintCommand(conn, {
    command: "gcode_file",
    param: remotePath,
  });

  return { remotePath, plateFile: plateEntry.name };
}

export async function sendControl(conn: BambuConnection, action: "pause" | "resume" | "stop"): Promise<void> {
  await publishPrintCommand(conn, { command: action });
}

function sanitizeFileName(name: string, requiredExt: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const withExt = base.toLowerCase().endsWith(requiredExt) ? base : `${base}${requiredExt}`;
  return withExt || `model${requiredExt}`;
}
