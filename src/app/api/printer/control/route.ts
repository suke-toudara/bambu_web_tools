import { NextRequest, NextResponse } from "next/server";
import { sendControl } from "@/lib/printer/bambu/print";

export const runtime = "nodejs";
export const maxDuration = 15;

const VALID_ACTIONS = new Set(["pause", "resume", "stop"]);

export async function POST(req: NextRequest) {
  try {
    const { host, serial, accessCode, action } = await req.json();
    if (!host || !serial || !accessCode || !VALID_ACTIONS.has(action)) {
      return NextResponse.json(
        { error: "host, serial, accessCode, and a valid action (pause|resume|stop) are required." },
        { status: 400 }
      );
    }
    await sendControl({ host, serial, accessCode }, action);
    return NextResponse.json({ status: "success", action });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send control command";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
