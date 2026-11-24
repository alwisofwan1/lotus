"use client";
import { memo, useCallback, useState } from "react";
import { Link2 } from "lucide-react";

interface Props {
  /** Resolve + add the pasted URL; reject with a user-presentable message. */
  onSubmit: (url: string) => Promise<void>;
}

/**
 * The player's single input: paste a YouTube link, Enter (or the paste event
 * itself) resolves it into the tracklist. States: idle → resolving → idle|error.
 */
export const MusicPasteBar = memo(function MusicPasteBar({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || resolving) return;
    setResolving(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  }, [onSubmit, resolving]);

  return (
    <div className="canvas-music-paste-wrap">
      <div className={`canvas-music-paste${error ? " canvas-music-paste--error" : ""}`}>
        <Link2 aria-hidden />
        <input
          type="text"
          value={value}
          placeholder="Paste a YouTube link…"
          aria-label="Paste a YouTube link"
          readOnly={resolving}
          onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(value); }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (pasted.trim()) {
              e.preventDefault();
              setValue(pasted.trim());
              void submit(pasted);
            }
          }}
        />
        {resolving ? <span className="canvas-music-spin" aria-label="Resolving track" /> : <span className="canvas-music-kbd">↵</span>}
      </div>
      {error ? <p className="canvas-music-paste-error" role="alert">{error}</p> : null}
    </div>
  );
});
