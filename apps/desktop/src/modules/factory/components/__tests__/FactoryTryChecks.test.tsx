import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FactoryTryChecks } from "../FactoryTryChecks";
import type { FactoryCheckTrialSource } from "../../services/factory-check-trial";
import type { FactoryCheckPreview, FactoryCheckTrial } from "@/lib/tauri/graph-run";
const preview: FactoryCheckPreview = { id: "trial", repo: "o/r", checkout: "/checkout", base: "main", revision: "a".repeat(40), command: "npm run test", shell: true, worktree: "/state/check-trials/trial", timeoutSeconds: 2400 };
const passed: FactoryCheckTrial = { ...preview, status: "passed", exitCode: 0, output: "tests passed", elapsedMs: 2000, currentRevision: preview.revision, message: "Checks exited successfully." };
function source(): FactoryCheckTrialSource {
  let result: FactoryCheckTrial | null = null;
  return {
    preview: vi.fn(async () => preview),
    start: vi.fn(async () => { result = passed; return passed; }),
    status: vi.fn(async () => result),
    cancel: vi.fn(async () => undefined),
  };
}
const props = { checkout: "/checkout", repo: "o/r", base: "main", command: "npm run test", shell: true, disabled: false };
describe("Factory Try checks", () => {
  it("requires explicit confirmation with worktree, revision and side-effect disclosure", async () => {
    const src = source();
    render(<FactoryTryChecks source={src} {...props} />);
    expect(src.preview).not.toHaveBeenCalled();
    expect(src.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try checks" }));
    expect(await screen.findByText(preview.worktree)).toBeTruthy();
    expect(screen.getByText(/not a security sandbox/i)).toBeTruthy();
    expect(screen.getByText(/not copied/i)).toBeTruthy();
    expect(src.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run checks now" }));
    expect(await screen.findByText("Passed")).toBeTruthy();
    expect(screen.getByText("tests passed")).toBeTruthy();
    expect(src.start).toHaveBeenCalledExactlyOnceWith("trial");
  });
  it("does not label a previous command or a changed revision as passed", async () => {
    const src = source();
    src.status = vi.fn(async () => passed);
    const { rerender } = render(<FactoryTryChecks source={src} {...props} />);
    expect(await screen.findByText("Passed")).toBeTruthy();
    rerender(<FactoryTryChecks source={src} {...props} command="new-check" />);
    expect(await screen.findByText("Outdated")).toBeTruthy();
    expect(screen.queryByText("Passed")).toBeNull();
    const changed = { ...src, status: vi.fn(async () => ({ ...passed, currentRevision: "b".repeat(40) })) };
    rerender(<FactoryTryChecks source={changed} {...props} />);
    expect(await screen.findByText("Outdated")).toBeTruthy();
    expect(src.start).not.toHaveBeenCalled();
  });
  it("ignores previews arriving after command edits", async () => {
    const src = source();
    let resolve!: (value: FactoryCheckPreview) => void;
    src.preview = vi.fn(() => new Promise<FactoryCheckPreview>((done) => { resolve = done; }));
    const { rerender } = render(<FactoryTryChecks source={src} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Try checks" }));
    rerender(<FactoryTryChecks source={src} {...props} command="edited" />);
    resolve(preview);
    await waitFor(() => expect(screen.getByRole("button", { name: "Try checks" })).not.toBeDisabled());
    expect(screen.queryByRole("button", { name: "Run checks now" })).toBeNull();
    expect(src.start).not.toHaveBeenCalled();
  });
  it("does not let a status read begun before Start erase its receipt", async () => {
    const src = source();
    let resolve!: (value: FactoryCheckTrial | null) => void;
    src.status = vi.fn(() => new Promise<FactoryCheckTrial | null>((done) => { resolve = done; }));
    render(<FactoryTryChecks source={src} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Try checks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run checks now" }));
    expect(await screen.findByText("Passed")).toBeTruthy();
    resolve(null);
    await waitFor(() => expect(screen.queryByText("Not verified")).toBeNull());
    expect(screen.getByText("Passed")).toBeTruthy();
  });
  it("does not claim success when revision or status cannot be checked", async () => {
    const src = source();
    src.status = vi.fn(async () => ({ ...passed, currentRevision: null }));
    const { rerender } = render(<FactoryTryChecks source={src} {...props} />);
    expect(await screen.findByText("Revision unknown")).toBeTruthy();
    const offline = { ...src, status: vi.fn(async () => { throw new Error("offline"); }) };
    rerender(<FactoryTryChecks source={offline} {...props} />);
    expect(await screen.findByText("Status unavailable")).toBeTruthy();
    expect(screen.queryByText("Passed")).toBeNull();
  });
  it("keeps Cancel available for an existing background trial", async () => {
    const src = source();
    src.status = vi.fn(async () => ({ ...passed, status: "running" as const, exitCode: null }));
    render(<FactoryTryChecks source={src} {...props} command="edited" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel checks" }));
    await waitFor(() => expect(src.cancel).toHaveBeenCalledExactlyOnceWith("o/r", "trial"));
    expect(screen.queryByText("Passed")).toBeNull();
  });
});
