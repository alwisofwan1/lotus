/** Match CSI and OSC before the short escape because its character range includes their prefixes. */
const ANSI_RE =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x1B\x07]*(?:\x1B\\|\x07)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
