import { tauriInvoke } from "@/lib/tauri/runtime";

export type SkillEntry = {
  name: string;
  description: string;
  content: string;
  source: "project" | "global";
  path: string;
  metadata?: Array<{ key: string; value: string }>;
};

export async function listSkills(projectPath?: string): Promise<SkillEntry[]> {
  return tauriInvoke<SkillEntry[]>("list_skills", { projectPath });
}

export async function createSkill(
  name: string,
  description: string,
  content: string,
  scope: "project" | "global",
  projectPath?: string,
): Promise<void> {
  return tauriInvoke("create_skill", { name, description, content, scope, projectPath });
}

export async function importSkillFromUrl(
  url: string,
  scope: "project" | "global",
  projectPath?: string,
): Promise<void> {
  return tauriInvoke("import_skill_from_url", { url, scope, projectPath });
}
