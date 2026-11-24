"use client";
import { useState, useCallback, useMemo } from "react";
import { Terminal, Plus, Loader } from "lucide-react";
import type { WorktreeEntry } from "@/lib/tauri/canvas-git";
import { getActiveProjectLocation } from "../../services/canvas-active-project";
import { createWorktreeFor } from "../../services/remote-git";

export interface WorktreeCreateFormProps {
  cwd: string;
  existingCount: number;
  writeToTerminal?: (cmd: string) => void;
  onCreated: (entry: WorktreeEntry) => void;
  onRefresh: () => void;
}

type CreateStatus = "idle" | "running" | "error";

function derivePath(cwd: string, branch: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  const repoName = parts.at(-1) ?? "repo";
  const parent = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "/tmp";
  const slug = branch.trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "wt";
  return `${parent}/${repoName}-${slug}`;
}

export function WorktreeCreateForm({ cwd, existingCount, writeToTerminal, onCreated, onRefresh }: WorktreeCreateFormProps) {
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState<CreateStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const autoPath = useMemo(() => derivePath(cwd, branch || `wt-${existingCount + 1}`), [cwd, branch, existingCount]);

  const handleViaTerminal = useCallback(() => {
    if (!writeToTerminal || !branch.trim()) return;
    const b = branch.trim();
    const p = autoPath;
    // Asks whether the branch exists instead of trying and falling back. The old form hid the
    // first attempt's stderr, so a branch another worktree already holds came back as "a branch
    // named 'x' already exists" — true, and the wrong reason. Same shape as the Rust builder.
    writeToTerminal(
      `if git show-ref --verify --quiet refs/heads/${b}; then git worktree add ${p} ${b}; else git worktree add -b ${b} ${p}; fi\n`,
    );
    setTimeout(onRefresh, 2500);
  }, [writeToTerminal, branch, autoPath, onRefresh]);

  const handleCreate = useCallback(async () => {
    if (!branch.trim()) return;
    setStatus("running");
    setError(null);
    try {
      const entry = await createWorktreeFor(getActiveProjectLocation(), cwd, branch.trim(), autoPath);
      setStatus("idle");
      setBranch("");
      onCreated(entry);
      onRefresh();
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cwd, branch, autoPath, onCreated, onRefresh]);

  const canSubmit = branch.trim().length > 0 && status !== "running";

  return (
    <div className="cwp-create-form">
      <div className="cwp-create-fields">
        <div className="cwp-create-field">
          <label className="cwp-create-label">Branch</label>
          <input
            className="cwp-create-input"
            placeholder="feat/my-feature"
            value={branch}
            onChange={(e) => { setBranch(e.target.value); setError(null); }}
            aria-label="Branch name"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="cwp-create-path-hint" title={autoPath}>
        <span className="cwp-create-path-arrow">→</span>
        <span className="cwp-create-path-text">{autoPath}</span>
      </div>

      {error && <p className="cwp-create-error">{error}</p>}

      <div className="cwp-create-footer">
        <div className="cwp-create-actions">
          {writeToTerminal && (
            <button
              className="cwp-action-btn cwp-action-btn--terminal"
              onClick={handleViaTerminal}
              disabled={!canSubmit}
              type="button"
              aria-label="Run via terminal"
            >
              <Terminal size={9} /> Terminal
            </button>
          )}
          <button
            className="cwp-action-btn cwp-action-btn--primary"
            onClick={handleCreate}
            disabled={!canSubmit}
            type="button"
            aria-label="Create worktree"
          >
            {status === "running"
              ? <><Loader size={9} className="cwp-spin" /> Creating…</>
              : <><Plus size={9} /> Create</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}
