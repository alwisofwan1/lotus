import type {
  BrowseResponse, CloneJob, CloneProjectRequest, HostedProject, ProjectListing,
} from "../types/index.js";
import type { ClientRequest } from "./api-client-util.js";

/** What exists on this host, running or not — shape varies by host, see `ProjectListing`. */
export function listProjects(request: ClientRequest): Promise<ProjectListing> {
  return request<ProjectListing>("GET", "/api/projects");
}

/** Starts a clone into the workspace root and answers with the job, not the result. */
export function cloneProject(request: ClientRequest, req: CloneProjectRequest): Promise<CloneJob> {
  return request<CloneJob>("POST", "/api/projects/clone", req);
}

export function cloneStatus(request: ClientRequest, taskId: string): Promise<CloneJob> {
  return request<CloneJob>("GET", `/api/projects/clone/${encodeURIComponent(taskId)}`);
}

/** One level of a directory this host opens, or the roots when `path` is absent. */
export function browse(request: ClientRequest, path: string | undefined): Promise<BrowseResponse> {
  const query = path === undefined || path.length === 0
    ? ""
    : `?path=${encodeURIComponent(path)}`;
  return request<BrowseResponse>("GET", `/api/fs${query}`);
}

/** Takes a directory already on the machine. Nothing is copied. */
export function addProject(request: ClientRequest, path: string): Promise<HostedProject> {
  return request<HostedProject>("POST", "/api/projects", { path });
}

/** Forgets one. The directory stays where it is. */
export function forgetProject(request: ClientRequest, id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("DELETE", `/api/projects/${encodeURIComponent(id)}`);
}
