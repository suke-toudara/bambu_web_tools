import { NextRequest, NextResponse } from "next/server";
import { parseStl } from "@/lib/stl/parseBinaryStl";
import { sliceMesh } from "@/lib/slicer/slice";
import { generateGcode } from "@/lib/slicer/gcode";
import { DEFAULT_SLICE_SETTINGS, type SliceSettings } from "@/lib/slicer/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const settingsRaw = form.get("settings");

    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "Missing STL file (field 'file')." }, { status: 400 });
    }

    let settings: SliceSettings = DEFAULT_SLICE_SETTINGS;
    if (typeof settingsRaw === "string") {
      try {
        settings = { ...DEFAULT_SLICE_SETTINGS, ...JSON.parse(settingsRaw) };
      } catch {
        return NextResponse.json({ error: "Invalid settings JSON." }, { status: 400 });
      }
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) {
      return NextResponse.json({ error: "Uploaded STL file is empty." }, { status: 400 });
    }

    const triangles = parseStl(buffer);
    if (triangles.length === 0) {
      return NextResponse.json({ error: "No triangles found in STL. Is the mesh watertight?" }, { status: 400 });
    }
    if (triangles.length > 400_000) {
      return NextResponse.json(
        { error: `Mesh has ${triangles.length} triangles; this basic slicer supports up to 400,000. Simplify the model first.` },
        { status: 413 }
      );
    }

    const result = sliceMesh(triangles, settings);
    if (result.layerCount === 0) {
      return NextResponse.json({ error: "Slicing produced zero layers. Check the model geometry and layer height." }, { status: 422 });
    }

    const gcode = generateGcode(result, settings);

    return NextResponse.json({
      gcode,
      stats: {
        layerCount: result.layerCount,
        estimatedTimeSec: result.estimatedTimeSec,
        estimatedFilamentMm: result.estimatedFilamentMm,
        estimatedFilamentGrams: result.estimatedFilamentGrams,
        boundsMin: result.boundsMin,
        boundsMax: result.boundsMax,
      },
      // Lightweight per-layer polygon preview (skip infill lines to keep payload small).
      layerPreview: result.layers.map((l) => ({
        z: l.z,
        perimeters: l.perimeters,
        supports: l.supports,
      })),
    });
  } catch (err) {
    console.error("slice error", err);
    const message = err instanceof Error ? err.message : "Unknown slicing error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
