import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

export async function GET(req: NextRequest) {
  const teamId = req.nextUrl.searchParams.get("teamId") ?? "";
  const since = parseInt(req.nextUrl.searchParams.get("since") ?? "0", 10);

  if (!teamId || !/^[\w-]+$/.test(teamId)) {
    return NextResponse.json({ error: "invalid teamId" }, { status: 400 });
  }

  const logFile = path.join(
    os.homedir(),
    ".claude",
    "agent-teams-logs",
    `${teamId}.log`
  );

  if (!fs.existsSync(logFile)) {
    return NextResponse.json({ text: "", newSize: 0 });
  }

  try {
    const stat = fs.statSync(logFile);
    const size = stat.size;

    if (since >= size) {
      return NextResponse.json({ text: "", newSize: size });
    }

    const maxRead = Math.min(size - since, 64 * 1024);
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(maxRead);
    const bytesRead = fs.readSync(fd, buf, 0, maxRead, since);
    fs.closeSync(fd);

    // Trim to last complete line (mirror Rust logic)
    let usable = bytesRead;
    if (usable > 0 && buf[usable - 1] !== 0x0a) {
      let cut = usable - 1;
      while (cut > 0 && buf[cut] !== 0x0a) cut--;
      if (cut === 0) {
        return NextResponse.json({ text: "", newSize: since });
      }
      usable = cut + 1;
    }

    const text = buf.subarray(0, usable).toString("utf-8");
    return NextResponse.json({ text, newSize: since + usable });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read log";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
