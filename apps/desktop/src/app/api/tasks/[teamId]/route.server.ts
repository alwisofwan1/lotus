import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { lotusTasksDir } from "@/app/api/_lotus-state";

function tasksDir(teamId: string) {
  return lotusTasksDir(teamId);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const { teamId } = await params;
  const dir = tasksDir(teamId);
  if (!fs.existsSync(dir)) return NextResponse.json([]);
  try {
    const tasks = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          return t.id ? [t] : [];
        } catch {
          return [];
        }
      });
    return NextResponse.json(tasks);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list tasks";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string }> }
) {
  const { teamId } = await params;
  try {
    const body = await req.json();
    const task = body.task ?? body;
    const dir = tasksDir(teamId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(task, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
