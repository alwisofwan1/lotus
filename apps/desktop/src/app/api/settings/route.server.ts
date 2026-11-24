import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

function settingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export async function GET() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return NextResponse.json({});
    return NextResponse.json(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {
    return NextResponse.json({});
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = body.settings ?? body;
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
