import path from "node:path";
import JSZip from "jszip";
import { ftpUpload } from "./ftp";
import { publishPrintCommand } from "./mqtt";
import type { BambuConnection } from "./types";

/**
 * Wraps plain gcode text in the minimal zip structure of a `.gcode.3mf`
 * ("Metadata/plate_1.gcode" plus the boilerplate 3MF/OPC files needed for it
 * to be a well-formed zip package). Sending a bare `.gcode` file via the
 * `gcode_file` MQTT command is not a verified print-start path on current
 * P1/A1/X1 firmware — community reports and live testing on an A1 both show
 * the printer silently ignoring it (no error, no reaction). Only
 * `gcode_file` + an actual `.gcode.3mf` container is confirmed working, so
 * the built-in slicer's output is packaged the same way and sent through
 * that path instead.
 */
async function packageAsGcode3mf(gcode: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
      "</Types>\n"
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
      "</Relationships>\n"
  );
  zip.file(
    "3D/3dmodel.model",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources>' +
      '<build><item objectid="1"/></build>' +
      "</model>\n"
  );
  zip.file("Metadata/plate_1.gcode", gcode);
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Slices don't need a filename on the way in; this only strips whatever
 * extension the caller passed so the container ends up named exactly
 * `<stem>.gcode.3mf`, matching the naming the firmware expects for this
 * container format.
 */
function toGcode3mfName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const stem = base.replace(/\.(gcode(\.3mf)?|3mf)$/i, "");
  return `${stem || "model"}.gcode.3mf`;
}

/**
 * Packages plain single-filament gcode (from the built-in slicer) as a
 * `.gcode.3mf` and starts it the same way `printProjectFile` does. See
 * `packageAsGcode3mf` for why a bare `.gcode` file isn't sent directly.
 */
export async function printGcodeFile(
  conn: BambuConnection,
  gcode: string,
  fileName: string
): Promise<{ remotePath: string }> {
  const buffer = await packageAsGcode3mf(gcode);
  const { remotePath } = await printProjectFile(conn, buffer, toGcode3mfName(fileName));
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
 * tool does not support. Because the printer opens
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
