const SGR_MOUSE_REPORT_RE = /^\x1b\[<(\d+);\d+;\d+M$/;
const DEFAULT_MOUSE_REPORT_RE = /^\x1b\[M([\s\S])([\s\S])([\s\S])$/;

const MOUSE_MOVE_FLAG = 32;
const MOUSE_BUTTON_MASK = 3;
const MOUSE_BUTTON_NONE = 3;

function isPassiveMouseMoveCode(code: number): boolean {
  return (code & MOUSE_MOVE_FLAG) !== 0 && (code & MOUSE_BUTTON_MASK) === MOUSE_BUTTON_NONE;
}

/**
 * xterm sends mouse tracking reports through `onData`, the same channel used for keyboard input.
 * Claude-family TUIs can enable ANY mouse tracking, where plain cursor hover emits a short report for
 * every grid-cell move. Live agent nodes are primarily watch/type surfaces, so passive hover reports
 * are dropped before they become one Tauri `write_to_session` request per mouse move. Clicks, drags,
 * wheel events, keyboard input, and pasted text still pass through unchanged.
 */
export function shouldDropLiveAgentTerminalInput(data: string): boolean {
  const sgr = SGR_MOUSE_REPORT_RE.exec(data);
  if (sgr) return isPassiveMouseMoveCode(Number(sgr[1]));

  const legacy = DEFAULT_MOUSE_REPORT_RE.exec(data);
  if (!legacy) return false;
  const eventCode = legacy[1].charCodeAt(0) - 32;
  return isPassiveMouseMoveCode(eventCode);
}

export function filterLiveAgentTerminalInput(data: string): string | null {
  return shouldDropLiveAgentTerminalInput(data) ? null : data;
}
