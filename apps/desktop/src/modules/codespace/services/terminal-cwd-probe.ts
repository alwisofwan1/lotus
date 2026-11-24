const CWD_OSC_PATTERN = /\x1b\]777;lotus-cwd=([^\x07\x1b]+)(?:\x07|\x1b\\)/g;

export function extractTerminalCwdUpdates(data: string): {
  visibleData: string;
  cwdUpdates: string[];
} {
  const cwdUpdates: string[] = [];
  const visibleData = data.replace(CWD_OSC_PATTERN, (_, cwd: string) => {
    const trimmed = cwd.trim();
    if (trimmed.startsWith("/")) {
      cwdUpdates.push(trimmed);
    }
    return "";
  });

  return { visibleData, cwdUpdates };
}
