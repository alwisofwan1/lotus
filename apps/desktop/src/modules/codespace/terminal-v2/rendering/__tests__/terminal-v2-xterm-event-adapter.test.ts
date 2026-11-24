import { describe, expect, it, vi } from "vitest";
import { attachTerminalV2XtermEvents } from "../terminal-v2-xterm-event-adapter";

describe("attachTerminalV2XtermEvents", () => {
  it("attaches renderer input, render, parsed-write, and custom-key handlers", () => {
    const dataDisposable = { dispose: vi.fn() };
    const renderDisposable = { dispose: vi.fn() };
    const parsedDisposable = { dispose: vi.fn() };
    let onDataListener: ((data: string) => void) | undefined;
    let onRenderListener: (() => void) | undefined;
    let onWriteParsedListener: (() => void) | undefined;
    let customKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
    const terminal = {
      onData: vi.fn((listener: (data: string) => void) => {
        onDataListener = listener;
        return dataDisposable;
      }),
      onRender: vi.fn((listener: () => void) => {
        onRenderListener = listener;
        return renderDisposable;
      }),
      onWriteParsed: vi.fn((listener: () => void) => {
        onWriteParsedListener = listener;
        return parsedDisposable;
      }),
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        customKeyHandler = handler;
      }),
    };
    const handlers = {
      onData: vi.fn(),
      onRender: vi.fn(),
      onWriteParsed: vi.fn(),
      onCustomKey: vi.fn(() => true),
    };

    const subscription = attachTerminalV2XtermEvents({ terminal, handlers });
    onDataListener?.("input");
    onRenderListener?.();
    onWriteParsedListener?.();
    customKeyHandler?.({ key: "Enter" } as KeyboardEvent);
    subscription.dispose();
    subscription.dispose();

    expect(handlers.onData).toHaveBeenCalledWith("input");
    expect(handlers.onRender).toHaveBeenCalledOnce();
    expect(handlers.onWriteParsed).toHaveBeenCalledOnce();
    expect(handlers.onCustomKey).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
    expect(dataDisposable.dispose).toHaveBeenCalledOnce();
    expect(renderDisposable.dispose).toHaveBeenCalledOnce();
    expect(parsedDisposable.dispose).toHaveBeenCalledOnce();
  });

  it("keeps cleanup best-effort when optional xterm events or disposers are absent", () => {
    let onDataListener: ((data: string) => void) | undefined;
    const terminal = {
      onData: vi.fn((listener: (data: string) => void) => {
        onDataListener = listener;
        return undefined;
      }),
    };
    const handlers = {
      onData: vi.fn(),
      onRender: vi.fn(),
      onWriteParsed: vi.fn(),
      onCustomKey: vi.fn(() => false),
    };

    const subscription = attachTerminalV2XtermEvents({ terminal, handlers });
    onDataListener?.("input");

    expect(() => subscription.dispose()).not.toThrow();
    expect(handlers.onData).toHaveBeenCalledWith("input");
    expect(handlers.onRender).not.toHaveBeenCalled();
    expect(handlers.onWriteParsed).not.toHaveBeenCalled();
    expect(handlers.onCustomKey).not.toHaveBeenCalled();
  });

  it("reports dispose errors and continues disposing the remaining event subscriptions", () => {
    const dataError = new Error("data dispose failed");
    const renderDisposable = { dispose: vi.fn() };
    const onDisposeError = vi.fn();
    const terminal = {
      onData: vi.fn(() => ({ dispose: vi.fn(() => { throw dataError; }) })),
      onRender: vi.fn(() => renderDisposable),
    };

    const subscription = attachTerminalV2XtermEvents({
      terminal,
      handlers: { onData: vi.fn(), onRender: vi.fn() },
      onDisposeError,
    });
    subscription.dispose();

    expect(onDisposeError).toHaveBeenCalledWith(dataError, "onData");
    expect(renderDisposable.dispose).toHaveBeenCalledOnce();
  });
});
