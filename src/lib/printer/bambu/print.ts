import { createHash, randomUUID } from "node:crypto";
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
 * be a well-formed, Bambu-recognisable container), so the built-in slicer's
 * output can go through the same `project_file` start path as a real
 * Bambu Studio/OrcaSlicer export (see `printProjectFile`). A bare `.gcode`
 * file has no verified print-start path on current P1/A1/X1 firmware.
 *
 * The package layout (production-extension namespace, `p:UUID` on the
 * object/build item, the `Application`/`3mfVersion` metadata, minimal
 * `slice_info.config`) mirrors what Bambu Studio itself writes, reverse-
 * engineered from a real A1 export by
 * https://github.com/m-esm/bambu-3mf-export — an earlier version of this
 * function used a bare core-spec-only model with an empty mesh, which is
 * one plausible reason the printer failed to parse it. `Metadata/model_settings.config`
 * (plus its `.rels`) was a second missing piece: see the comment above it
 * below for why the printer needs it to find the plate gcode at all — this
 * was reverse-engineered from OrcaSlicer's actual writer/reader
 * (`bbs_3mf.cpp`, `GCODE_FILE_ATTR` / `BBS_MODEL_CONFIG_RELS_FILE`), not
 * from community guesswork.
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
    '<Default Extension="gcode" ContentType="text/x.gcode"/>' +
    '<Default Extension="config" ContentType="application/vnd.bambulab.print.config"/>' +
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

  // Bambu's own reader (see OrcaSlicer's bbs_3mf.cpp _BBS_3MF_Importer) does not
  // locate the plate gcode by filename convention alone: it reads the
  // `gcode_file` metadata key inside a `<plate>` block of
  // Metadata/model_settings.config. Without this file, the firmware has no way
  // to resolve "which entry in this package is the gcode to run" and rejects
  // the whole container as unparsable.
  const modelSettings =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
    ` <object id="${objectId}">\n` +
    '  <metadata key="name" value="plate_1"/>\n' +
    '  <metadata key="extruder" value="1"/>\n' +
    " </object>\n" +
    " <plate>\n" +
    '  <metadata key="plater_id" value="1"/>\n' +
    '  <metadata key="plater_name" value=""/>\n' +
    '  <metadata key="locked" value="false"/>\n' +
    '  <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>\n' +
    "  <model_instance>\n" +
    `   <metadata key="object_id" value="${objectId}"/>\n` +
    '   <metadata key="instance_id" value="0"/>\n' +
    "  </model_instance>\n" +
    " </plate>\n" +
    "</config>\n";

  const modelSettingsRels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>' +
    "</Relationships>\n";

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("3D/3dmodel.model", model);
  zip.file("Metadata/slice_info.config", sliceInfo);
  zip.file("Metadata/model_settings.config", modelSettings);
  zip.file("Metadata/_rels/model_settings.config.rels", modelSettingsRels);
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
 * via "Export plate sliced file") and starts it via the `project_file` MQTT
 * command — the same command Bambu Studio/OrcaSlicer themselves use to start
 * any print, on every printer family (there is no P1/A1/X1-specific
 * exception; an earlier version of this code assumed there was, based on a
 * `project_file` attempt that got rejected with error 405004002 — that
 * rejection was actually caused by the container itself being malformed,
 * not the command choice; see `packageAsGcode3mf` for what was missing).
 * `gcode_file` is the wrong command for a `.gcode.3mf`: per the LAN mode
 * protocol (https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md#printgcode_file)
 * it only takes a plain `.gcode` file already on the printer's filesystem,
 * not a 3MF container — sending a container path through it is silently
 * accepted and then never actually opened.
 *
 * `md5` is computed from the exact bytes uploaded; firmware is not
 * confirmed to verify it, but Bambu Studio always sends the real hash, not
 * an empty string. Since the built-in slicer doesn't do AMS mapping,
 * `ams_mapping`/`use_ams` are fixed at single-filament/no-AMS for both
 * printGcodeFile and printProjectFile; a pre-sliced file that actually uses
 * the AMS is not correctly represented by this and needs future work.
 *
 * KNOWN ISSUE: even with all of the above, live testing against an A1 gets
 * `"result":"success"` for the command itself, but the printer then reports
 * `print_error` 0x0500C010 and returns to idle without starting — an
 * undocumented error also seen by other third-party LAN clients against
 * Bambu's official firmware (see
 * https://github.com/bambulab/BambuStudio/issues/4495, adjacent code
 * 0500C011, unresolved). The fixes here are still an improvement (the
 * command is now accepted instead of outright rejected) but do not yet
 * result in a running print.
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

  const md5 = createHash("md5").update(fileBuffer).digest("hex");
  await publishPrintCommand(conn, {
    command: "project_file",
    param: plateEntry.name,
    project_id: "0",
    profile_id: "0",
    task_id: "0",
    subtask_id: "0",
    subtask_name: safeName,
    file: "",
    url: `ftp:///${remotePath}`,
    md5,
    timelapse: false,
    bed_type: "auto",
    bed_levelling: true,
    flow_cali: false,
    vibration_cali: false,
    layer_inspect: false,
    ams_mapping: [0, -1, -1, -1, -1],
    use_ams: false,
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
