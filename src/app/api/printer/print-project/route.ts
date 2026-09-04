import { NextRequest, NextResponse } from "next/server";
import { printProjectFile } from "@/lib/printer/bambu/print";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const host = form.get("host");
    const serial = form.get("serial");
    const accessCode = form.get("accessCode");

    if (!(file instanceof Blob) || typeof host !== "string" || typeof serial !== "string" || typeof accessCode !== "string") {
      return NextResponse.json(
        { error: "file, host, serial, and accessCode are required." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await printProjectFile(
      { host, serial, accessCode },
      buffer,
      (file as File).name || "model.gcode.3mf"
    );
    return NextResponse.json({ status: "success", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to print project file";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
