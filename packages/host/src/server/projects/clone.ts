import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Git } from "../../core/git.js";
import type { CloneJob, CloneProjectRequest } from "../../types/projects.js";

export type { CloneJob, CloneProjectRequest };

/** The name cannot become a project directory — a separator, a dot entry, or nothing. */
export class InvalidCloneTargetError extends Error {}

/** Something already occupies the destination. Cloning would merge into it or fail late. */
export class CloneTargetExistsError extends Error {}

export interface ProjectClonerDeps {
  /** Runs `git`; injected so tests never reach a real remote. */
  git: Git;
  /** The workspace root clones land in — `PROJECTS_ROOT`, which the registry scans. */
  root: string;
  newId?: () => string;
  /**
   * Reports whether `gh` on this machine is authenticated. Read **only** when a clone
   * failed, because it is a hint about the cause and never a reason to refuse.
   */
  ghAuth?: () => Promise<string>;
}

/** Clones a repository into the workspace root, as a job the caller may stop watching. */
export class ProjectCloner {
  private readonly git: Git;
  private readonly root: string;
  private readonly newId: () => string;
  private readonly ghAuth: (() => Promise<string>) | undefined;
  private readonly jobs = new Map<string, CloneJob>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(deps: ProjectClonerDeps) {
    this.git = deps.git;
    this.root = deps.root;
    this.newId = deps.newId ?? (() => `clone_${randomUUID()}`);
    this.ghAuth = deps.ghAuth;
  }

  start(req: CloneProjectRequest): CloneJob {
    const name = folderName(req.url, req.name);
    if (!isUsableName(name)) {
      throw new InvalidCloneTargetError(`Cannot use "${name}" as a project folder`);
    }
    const target = join(this.root, name);
    if (existsSync(target)) {
      throw new CloneTargetExistsError(`${target} already exists`);
    }
    const job: CloneJob = {
      taskId: this.newId(),
      state: "running",
      step: "resolving",
      name,
      path: join(this.root, name),
    };
    this.jobs.set(job.taskId, job);
    this.running.set(job.taskId, this.run(job, req));
    return job;
  }

  get(taskId: string): CloneJob | undefined {
    return this.jobs.get(taskId);
  }

  /** Resolves when the job is no longer running. */
  async settled(taskId: string): Promise<void> {
    await this.running.get(taskId);
  }

  /** Stage in a hidden sibling so the registry never sees a partial clone. */
  private async run(job: CloneJob, req: CloneProjectRequest): Promise<void> {
    const staging = `.lotus-clone-${job.taskId}`;
    job.step = "cloning";
    const result = await this.git(this.root, [
      "clone",
      ...(req.branch === undefined || req.branch.length === 0 ? [] : ["--branch", req.branch]),
      "--",
      req.url,
      staging,
    ]);
    if (result.code !== 0) {
      rmSync(join(this.root, staging), { recursive: true, force: true });
      job.state = "failed";
      job.error = await this.withGhHint(result.stderr.trim());
      return;
    }
    job.step = "registering";
    renameSync(join(this.root, staging), job.path);
    job.state = "done";
  }

  private async withGhHint(message: string): Promise<string> {
    if (this.ghAuth === undefined) return message;
    return `${message}\n\ngh auth status → ${await this.ghAuth()}`;
  }
}

/** Reject dot-prefixed names because the registry skips hidden directories. */
function isUsableName(name: string): boolean {
  if (name.length === 0) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return !name.startsWith(".");
}

/** The last path segment of a repository URL, without its `.git` suffix. */
function folderName(url: string, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const last = url.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "");
}
