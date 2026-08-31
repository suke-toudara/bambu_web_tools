import { NextRequest, NextResponse } from "next/server";
import { printGcodeFile } from "@/lib/printer/bambu/print";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { host, serial, accessCode, gcode, fileName } = await req.json();
    if (!host || !serial || !accessCode || !gcode) {
      return NextResponse.json(
        { error: "host, serial, accessCode, and gcode are required." },
        { status: 400 }
      );
    }
    const result = await printGcodeFile(
      { host, serial, accessCode },
      gcode,
      fileName || "model.gcode"
    );
    return NextResponse.json({ status: "success", ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to print gcode";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
