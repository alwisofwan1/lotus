import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { lotusLogsDir, lotusProcsFile, lotusTasksDir, lotusTeamsDir } from "@/app/api/_lotus-state";

function now() {
  return new Date().toISOString();
}

function buildPrompt(config: Record<string, unknown>): string {
  const workDir =
    (config.projectDir as string) || os.homedir();
  const agents = (config.agents as Array<Record<string, string>>) ?? [];
  const agentList = agents
    .map(
      (a, i) =>
        `  ${i + 1}. ${a.name} (${a.role}) — ${a.prompt || `Expert ${a.role} engineer`}`
    )
    .join("\n");

  const tasks = config.tasks as string[] | undefined;
  const taskList =
    tasks && tasks.length > 0
      ? tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n")
      : "  (determine tasks based on the goal)";

  const goal = (config.goal as string) || (config.name as string) || "";
  const planApproval = config.requirePlanApproval
    ? "Require plan approval from each teammate before they make any changes."
    : "";
  const displayMode =
    config.displayMode === "split-panes"
      ? "Use split-pane display mode."
      : "Use in-process display mode.";

  return `You are the Team Lead for an agent team working on: ${workDir}.

Goal: ${goal}

Create an agent team with these teammates:
${agentList}

Tasks to complete:
${taskList}

Project directory: ${workDir}
${planApproval}
${displayMode}

Spawn the teammates now and assign them their tasks. Work independently in parallel. Synthesize results when done.`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config: Record<string, unknown> = body.config ?? body;

    const workDir =
      (config.projectDir as string) || os.homedir();

    if (!fs.existsSync(workDir)) {
      return NextResponse.json(
        { error: `Directory not found: ${workDir}` },
        { status: 400 }
      );
    }

    const teamId = randomUUID().split("-")[0];
    const prompt = buildPrompt(config);

    const agents = (config.agents as Array<Record<string, string>>) ?? [];
    const model =
      (config.leadModel as string) ||
      (agents[0]?.model) ||
      "claude-haiku-4-5";

    const escapedPrompt = prompt.replace(/'/g, "'\"'\"'");
    const shellCmd = `cd '${workDir}' && CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --model ${model} '${escapedPrompt}'`;

    // Persist team config
    const teamsDir = lotusTeamsDir();
    const teamConfig = {
      id: teamId,
      name: config.name,
      description: config.goal,
      project:
        config.project ||
        path.basename(workDir),
      projectDir: workDir,
      displayMode: config.displayMode,
      requirePlanApproval: config.requirePlanApproval,
      leadModel: config.leadModel,
      createdAt: now(),
      status: "idle",
      members: agents.map((a) => ({
        name: a.name,
        agentId: randomUUID().split("-")[0],
        agentType: "teammate",
        model: a.model,
        role: a.role,
        status: "spawning",
        pid: null,
      })),
    };
    const teamCfgPath = path.join(teamsDir, teamId, "config.json");
    fs.mkdirSync(path.dirname(teamCfgPath), { recursive: true });
    fs.writeFileSync(teamCfgPath, JSON.stringify(teamConfig, null, 2));

    // Persist tasks
    const tasks = config.tasks as string[] | undefined;
    if (tasks && tasks.length > 0) {
      const tasksDir = lotusTasksDir(teamId);
      fs.mkdirSync(tasksDir, { recursive: true });
      tasks.forEach((title, idx) => {
        const task = {
          id: `task-${idx + 1}`,
          teamId,
          title,
          status: "pending",
          priority: "medium",
          dependencies: [],
          tags: [],
          createdAt: now(),
          updatedAt: now(),
        };
        fs.writeFileSync(
          path.join(tasksDir, `task-${idx + 1}.json`),
          JSON.stringify(task, null, 2)
        );
      });
    }

    const logDir = lotusLogsDir();
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${teamId}.log`);

    if (config.dryRun) {
      return NextResponse.json({
        ok: true,
        teamId,
        pid: null,
        logFile: "",
        workDir,
        shellCmd,
      });
    }

    const header = [
      `=== ${config.name} (${teamId}) — ${now()} ===`,
      `=== Working dir: ${workDir} ===`,
      `=== Shell command: ===`,
      shellCmd,
      "",
      "",
    ].join("\n");
    fs.writeFileSync(logFile, header);

    const child = spawn(
      "claude",
      [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--model",
        model,
        prompt,
      ],
      {
        cwd: workDir,
        env: { ...process.env, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      }
    );

    const pid = child.pid;

    // Stream stdout + stderr to log file (non-blocking)
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    child.unref();

    // Track PID
    const procsFile = lotusProcsFile();
    let procs: unknown[] = [];
    try {
      procs = JSON.parse(fs.readFileSync(procsFile, "utf-8"));
    } catch { /* first run */ }
    procs.push({ pid, teamId, projectDir: workDir, startedAt: now(), cmd: "claude" });
    fs.writeFileSync(procsFile, JSON.stringify(procs, null, 2));

    return NextResponse.json({
      ok: true,
      teamId,
      pid: pid ?? null,
      logFile,
      workDir,
      shellCmd,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Launch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
