export type TerminalV2XtermEventDisposable = { dispose(): void };

export type TerminalV2XtermEventTerminal = {
  onData?: (listener: (data: string) => void) => TerminalV2XtermEventDisposable | undefined;
  onRender?: (listener: () => void) => TerminalV2XtermEventDisposable | undefined;
  onWriteParsed?: (listener: () => void) => TerminalV2XtermEventDisposable | undefined;
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
};

export type TerminalV2XtermEventHandlers = {
  onData?: (data: string) => void;
  onRender?: () => void;
  onWriteParsed?: () => void;
  onCustomKey?: (event: KeyboardEvent) => boolean;
};

export type TerminalV2XtermEventAdapterOptions = {
  terminal: TerminalV2XtermEventTerminal;
  handlers: TerminalV2XtermEventHandlers;
  onDisposeError?: (error: unknown, source: "onData" | "onRender" | "onWriteParsed") => void;
};

function disposeSafely(
  disposable: TerminalV2XtermEventDisposable | undefined,
  source: "onData" | "onRender" | "onWriteParsed",
  onDisposeError?: TerminalV2XtermEventAdapterOptions["onDisposeError"],
) {
  if (!disposable) return;
  try {
    disposable.dispose();
  } catch (error) {
    onDisposeError?.(error, source);
  }
}

export function attachTerminalV2XtermEvents({
  terminal,
  handlers,
  onDisposeError,
}: TerminalV2XtermEventAdapterOptions): TerminalV2XtermEventDisposable {
  const dataDisposable = handlers.onData && terminal.onData
    ? terminal.onData((data) => handlers.onData?.(data))
    : undefined;
  const renderDisposable = handlers.onRender && terminal.onRender
    ? terminal.onRender(() => handlers.onRender?.())
    : undefined;
  const writeParsedDisposable = handlers.onWriteParsed && terminal.onWriteParsed
    ? terminal.onWriteParsed(() => handlers.onWriteParsed?.())
    : undefined;

  if (handlers.onCustomKey && terminal.attachCustomKeyEventHandler) {
    terminal.attachCustomKeyEventHandler((event) => handlers.onCustomKey?.(event) ?? false);
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeSafely(dataDisposable, "onData", onDisposeError);
      disposeSafely(renderDisposable, "onRender", onDisposeError);
      disposeSafely(writeParsedDisposable, "onWriteParsed", onDisposeError);
    },
  };
}
