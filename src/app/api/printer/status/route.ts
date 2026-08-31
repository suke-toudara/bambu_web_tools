import { NextRequest, NextResponse } from "next/server";
import { getStatus } from "@/lib/printer/bambu/mqtt";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  try {
    const { host, serial, accessCode } = await req.json();
    if (!host || !serial || !accessCode) {
      return NextResponse.json({ error: "host, serial, and accessCode are required." }, { status: 400 });
    }
    const status = await getStatus({ host, serial, accessCode });
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to reach printer";
    return NextResponse.json({ connected: false, error: message }, { status: 502 });
  }
}
