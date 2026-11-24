const TRUST_KEY = "ccs-trusted-dirs";

export function getTrustedTerminalDirs(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TRUST_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function rememberTrustedTerminalDir(dir: string): void {
  const dirs = getTrustedTerminalDirs();
  dirs.add(dir);
  localStorage.setItem(TRUST_KEY, JSON.stringify([...dirs]));
}
