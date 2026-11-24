import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { openExternalLink } from "@/lib/tauri-api";
import { gitGraphCommit, gitGraphFilePair, type CommitDetail, type CommitFile, type CommitFilePair } from "@/lib/tauri/git-graph";
import { splitMessage } from "@/modules/codespace/services/git-graph-message";
import { WorkbenchDiffPreview } from "../workbench/WorkbenchDiffPreview";
import "@/styles/git-graph.css";

type Load<T> = { key: string; value: T | null; error: string | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fullDate(time: number): string {
  const at = new Date(time * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const baseName = (path: string) => path.split("/").pop() ?? path;

function counts(file: CommitFile): string {
  if (file.binary) return "binary";
  const parts = [file.additions ? `+${file.additions}` : "", file.deletions ? `−${file.deletions}` : ""].filter(Boolean);
  return parts.join(" ");
}

/** Text with its commit hashes and `#N` as links. */
function Linked({ text, githubUrl, onOpenCommit }: { text: string; githubUrl: string | null; onOpenCommit: (sha: string) => void }) {
  return (
    <>
      {splitMessage(text).map((part, index) => {
        if (part.kind === "sha") {
          return <button key={index} type="button" className="gg-link" onClick={() => onOpenCommit(part.text)}>{part.text}</button>;
        }
        if (part.kind === "issue" && githubUrl) {
          const url = `${githubUrl}/issues/${part.number}`;
          return <button key={index} type="button" className="gg-link" title={url} onClick={() => void openExternalLink(url)}>{part.text}</button>;
        }
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

export type GitCommitViewProps = {
  repoRoot: string;
  sha: string;
  fontSize?: number;
  onOpenCommit: (sha: string) => void;
  /** Opens today's copy of a repo-relative path. */
  onOpenFile: (repoRelativePath: string) => void;
};

/** One commit: message, author, date, parents, changed files, and the selected file's diff (Q4, Q18). */
export function GitCommitView({ repoRoot, sha, fontSize, onOpenCommit, onOpenFile }: GitCommitViewProps) {
  const commitKey = `${repoRoot}\n${sha}`;
  const [detail, setDetail] = useState<Load<CommitDetail> | null>(null);
  const [picked, setPicked] = useState<{ key: string; path: string } | null>(null);
  const [allowLarge, setAllowLarge] = useState<string | null>(null);
  const [pair, setPair] = useState<Load<CommitFilePair> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    gitGraphCommit(repoRoot, sha)
      .then((value) => live && setDetail({ key: commitKey, value, error: null }))
      .catch((error) => live && setDetail({ key: commitKey, value: null, error: message(error) }));
    return () => {
      live = false;
    };
  }, [commitKey, repoRoot, sha]);

  const current = detail?.key === commitKey ? detail : null;
  const commit = current?.value ?? null;
  const file = commit
    ? commit.files.find((candidate) => picked?.key === commitKey && candidate.path === picked.path) ?? commit.files[0] ?? null
    : null;
  const pairKey = file ? `${commitKey}\n${file.path}\n${allowLarge === file.path}` : null;
  const parent = commit?.parents[0] ?? null;

  useEffect(() => {
    if (!file || !pairKey) return;
    if (file.binary) {
      setPair({ key: pairKey, value: { original: null, modified: null, binary: true, tooLarge: false }, error: null });
      return;
    }
    let live = true;
    gitGraphFilePair(repoRoot, sha, parent, file, allowLarge === file.path)
      .then((value) => live && setPair({ key: pairKey, value, error: null }))
      .catch((error) => live && setPair({ key: pairKey, value: null, error: message(error) }));
    return () => {
      live = false;
    };
    // `file` is read through its key: a new object for the same file must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, parent, repoRoot, sha]);

  if (!current) return <div className="gg-commit gg-commit-empty">Loading commit…</div>;
  if (!commit) {
    return (
      <div className="gg-commit gg-commit-empty">
        <div className="gg-state"><b>Could not read this commit.</b><code className="gg-error">{current.error}</code></div>
      </div>
    );
  }

  const [, ...bodyLines] = commit.message.split("\n");
  const body = bodyLines.join("\n").trim();
  const shownPair = pair?.key === pairKey ? pair : null;
  const filePath = file ? `${repoRoot}/${file.path}` : null;

  let diff;
  if (!file) diff = <div className="gg-nodiff">This commit changes no files.</div>;
  else if (!shownPair) diff = <div className="gg-nodiff">Loading diff…</div>;
  else if (shownPair.error) diff = <div className="gg-nodiff">Could not read this file: {shownPair.error}</div>;
  else if (shownPair.value?.binary) diff = <div className="gg-nodiff">Binary file. No text diff.</div>;
  else if (shownPair.value?.tooLarge) {
    diff = (
      <div className="gg-nodiff">
        This file is over 1 MB, so its diff is not shown.{" "}
        <button type="button" className="gg-link" onClick={() => setAllowLarge(file.path)}>Show anyway</button>
      </div>
    );
  } else {
    diff = (
      <WorkbenchDiffPreview
        content=""
        originalContent={shownPair.value?.original ?? ""}
        modifiedContent={shownPair.value?.modified ?? ""}
        originalPath={`git-graph://${sha}/original/${file.oldPath ?? file.path}`}
        modifiedPath={`git-graph://${sha}/modified/${file.path}`}
        filePath={filePath}
        renderSideBySide
        loading={false}
        error={null}
        emptyLabel="Empty file on both sides."
        fontSize={fontSize}
      />
    );
  }

  return (
    <div className="gg-commit">
      <header className="gg-commit-head">
        <div className="gg-commit-subject">{commit.subject}</div>
        {body ? (
          <div className="gg-commit-body">
            <Linked text={body} githubUrl={commit.githubUrl} onOpenCommit={onOpenCommit} />
          </div>
        ) : null}
        <div className="gg-commit-meta">
          <span title={commit.authorEmail}>{commit.author}</span>
          <span>{fullDate(commit.time)}</span>
          <code>{commit.sha.slice(0, 10)}</code>
          <button
            type="button"
            className="gg-link is-quiet"
            onClick={() => {
              void copyTextToClipboard(commit.sha).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied" : "Copy hash"}
          </button>
          {commit.parents.length > 0 ? (
            <span>
              {commit.parents.length > 1 ? "Parents " : "Parent "}
              {commit.parents.map((p, index) => (
                <span key={p}>
                  {index > 0 ? ", " : ""}
                  <button type="button" className="gg-link" onClick={() => onOpenCommit(p)}>{p.slice(0, 7)}</button>
                </span>
              ))}
              {commit.parents.length > 1 ? <span className="gg-quiet"> · diff against the first</span> : null}
            </span>
          ) : null}
        </div>
      </header>
      <div className="gg-commit-main">
        <div className="gg-files" role="listbox" aria-label="Changed files">
          {commit.files.map((candidate) => (
            <button
              key={candidate.path}
              type="button"
              role="option"
              aria-selected={candidate === file}
              className="gg-file"
              title={candidate.oldPath ? `${candidate.oldPath} → ${candidate.path}` : candidate.path}
              onClick={() => setPicked({ key: commitKey, path: candidate.path })}
            >
              <span className={cn("gg-file-status", `is-${candidate.status}`)}>{candidate.status}</span>
              <span className="gg-file-name">{candidate.oldPath ? `${baseName(candidate.oldPath)} → ${baseName(candidate.path)}` : baseName(candidate.path)}</span>
              <span className="gg-file-count">{counts(candidate)}</span>
            </button>
          ))}
          {commit.filesTruncated ? <div className="gg-end">Showing the first {commit.files.length} files.</div> : null}
        </div>
        <div className="gg-diff">
          {file ? (
            <div className="gg-diff-bar">
              <span className="gg-mono gg-diff-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
              {file.status !== "D" ? (
                <button type="button" className="gg-link is-quiet" onClick={() => onOpenFile(file.path)} title="Open today's version of this file">Open file</button>
              ) : null}
            </div>
          ) : null}
          {diff}
        </div>
      </div>
    </div>
  );
}
