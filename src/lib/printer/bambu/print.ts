import { randomUUID } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { ftpUpload } from "./ftp";
import { publishPrintCommand } from "./mqtt";
import type { BambuConnection } from "./types";

/** A small cube, just so `3D/3dmodel.model` carries real (non-empty)
 * geometry instead of an empty `<mesh>` — cheap insurance against a strict
 * 3MF validator on the firmware side rejecting a degenerate mesh. */
const CUBE_VERTICES: [number, number, number][] = [
  [0, 0, 0],
  [20, 0, 0],
  [20, 20, 0],
  [0, 20, 0],
  [0, 0, 20],
  [20, 0, 20],
  [20, 20, 20],
  [0, 20, 20],
];
const CUBE_TRIANGLES: [number, number, number][] = [
  [0, 1, 2],
  [0, 2, 3],
  [4, 6, 5],
  [4, 7, 6],
  [0, 4, 5],
  [0, 5, 1],
  [1, 5, 6],
  [1, 6, 2],
  [2, 6, 7],
  [2, 7, 3],
  [3, 7, 4],
  [3, 4, 0],
];

/**
 * Wraps plain gcode text in the zip structure of a `.gcode.3mf`
 * ("Metadata/plate_1.gcode" plus the OPC/3MF package files needed for it to
 * be a well-formed, Bambu-recognisable container). Sending a bare `.gcode`
 * file via the `gcode_file` MQTT command is not a verified print-start path
 * on current P1/A1/X1 firmware — community reports and live testing on an
 * A1 both show the printer silently ignoring it (no error, no reaction).
 * Only `gcode_file` + an actual `.gcode.3mf` container is confirmed
 * working, so the built-in slicer's output is packaged the same way and
 * sent through that path instead.
 *
 * The package layout (production-extension namespace, `p:UUID` on the
 * object/build item, the `Application`/`3mfVersion` metadata, minimal
 * `slice_info.config`) mirrors what Bambu Studio itself writes, reverse-
 * engineered from a real A1 export by
 * https://github.com/m-esm/bambu-3mf-export — an earlier version of this
 * function used a bare core-spec-only model with an empty mesh, which is
 * one plausible reason the printer failed to parse it.
 */
async function packageAsGcode3mf(gcode: string): Promise<Buffer> {
  const objectId = 2; // Bambu convention: object ids start at 2.
  const vertices = CUBE_VERTICES.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const triangles = CUBE_TRIANGLES.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("");

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
    'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
    'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" ' +
    'requiredextensions="p">\n' +
    ' <metadata name="Application">BambuStudio-02.06.00.51</metadata>\n' +
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
    " <resources>\n" +
    `  <object id="${objectId}" p:UUID="${randomUUID()}" type="model">\n` +
    `   <mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh>\n` +
    "  </object>\n" +
    " </resources>\n" +
    ` <build p:UUID="${randomUUID()}">\n` +
    `  <item objectid="${objectId}" p:UUID="${randomUUID()}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n` +
    " </build>\n" +
    "</model>\n";

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    "</Types>\n";

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    "</Relationships>\n";

  const sliceInfo =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    '    <header_item key="X-BBL-Client-Version" value="02.06.00.51"/>\n' +
    "  </header>\n</config>\n";

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("3D/3dmodel.model", model);
  zip.file("Metadata/slice_info.config", sliceInfo);
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
