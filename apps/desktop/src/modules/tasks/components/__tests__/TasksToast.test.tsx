import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksToast } from "@/modules/tasks/components/TasksToast";

afterEach(() => vi.useRealTimers());

describe("TasksToast", () => {
  it("leaves after ms even when the caller re-renders it with new inline callbacks", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const view = (n: number) => <TasksToast label="x" message={`m${n}`} action="Undo" onAction={() => {}} onDismiss={() => onDismiss(n)} ms={1000} />;
    const { rerender } = render(view(0));
    act(() => vi.advanceTimersByTime(600));
    rerender(view(1));
    act(() => vi.advanceTimersByTime(500));
    // The latest callback runs, on the first render's clock.
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("runs the action from its button", () => {
    const onAction = vi.fn();
    render(<TasksToast label="x" message="m" action="Undo" onAction={onAction} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    expect(onAction).toHaveBeenCalled();
  });
});
