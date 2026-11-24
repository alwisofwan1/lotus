import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

export async function getSettings(): Promise<Record<string, unknown>> {
  return tauriInvoke<Record<string, unknown>>("get_settings");
}

export async function saveSettings(settings: Record<string, unknown>): Promise<void> {
  return tauriInvoke("save_settings", { settings });
}

export async function openNewWindow(route = "/"): Promise<void> {
  if (!isTauri()) {
    window.open(route, "_blank", "noopener,noreferrer");
    return;
  }

  return tauriInvoke("open_new_window", { route });
}

export async function openPathInEditor(
  path: string,
  cwd: string,
  line?: number,
  column?: number,
): Promise<void> {
  if (!isTauri()) {
    return;
  }

  return tauriInvoke("open_path_in_editor", { path, cwd, line, column });
}
