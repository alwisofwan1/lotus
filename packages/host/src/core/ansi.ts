/**
 * Matches ANSI/VT escape sequences including:
 * - CSI sequences:  ESC [ ... final
 * - OSC sequences:  ESC ] ... ST  (ST = ESC\ or BEL)
 * - Simple escapes: ESC followed by a single char in range @-Z, \, _
 */
// Order matters: CSI and OSC must come before the catch-all two-char escape
// because [@-Z\\-_] (0x40-0x5F) also covers ] (0x5D) and [ (0x5B).
const ANSI_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x1B\x07]*(?:\x1B\\|\x07)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
