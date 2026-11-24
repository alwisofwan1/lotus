import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

export async function GET() {
  const procsFile = path.join(os.homedir(), ".claude", "agent-teams-procs.json");
  if (!fs.existsSync(procsFile)) return NextResponse.json([]);
  try {
    const procs = JSON.parse(fs.readFileSync(procsFile, "utf-8"));
    return NextResponse.json(Array.isArray(procs) ? procs : []);
  } catch {
    return NextResponse.json([]);
  }
}
