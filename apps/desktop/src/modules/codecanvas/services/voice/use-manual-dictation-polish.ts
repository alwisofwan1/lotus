import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

interface Options {
  text: string;
  blocked: boolean;
  build: (text: string, polish: boolean, signal?: AbortSignal) => Promise<string>;
  setText: Dispatch<SetStateAction<string>>;
}

export function useManualDictationPolish({ text, blocked, build, setText }: Options) {
  const active = useRef<AbortController | null>(null);
  const [polishing, setPolishing] = useState(false);
  const cancel = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setPolishing(false);
  }, []);

  useEffect(() => {
    cancel();
    return () => { active.current?.abort(); active.current = null; };
  }, [text, blocked, cancel]);

  const polish = useCallback(async () => {
    if (blocked || !text.trim() || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPolishing(true);
    try {
      const result = await build(text, true, controller.signal);
      if (!controller.signal.aborted && active.current === controller) setText(result);
    } catch {
      // Keep the editable draft when an adapter fails; cleanup is optional.
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPolishing(false);
      }
    }
  }, [text, blocked, build, setText]);

  return { polishing, polish, cancel };
}
