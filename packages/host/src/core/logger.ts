export type LogSink = (line: string) => void;

export type AuditEvent =
  | "host.start"
  | "host.stop"
  | "device.paired"
  | "pairing.code_issued"
  | "device.refreshed"
  // A lapsed device back in on a hardware-key signature rather than a pairing code.
  | "device.renewed"
  | "device.revoked"
  // Where to wake a device, registered or withdrawn (ADR-4). The registration token
  // itself is never a field on these — it is the capability to ring that phone.
  | "device.push_registered"
  | "device.push_cleared"
  | "cell.stopped"
  // Key-level input from a phone (V2). Carries a byte **count** and never the bytes:
  // an audit trail that recorded keystrokes would be a keylogger with a good excuse,
  // and this one is read by whoever holds the machine, not only by whoever typed.
  | "cell.input"
  // The one irreversible thing a phone can do. Kept distinct from `cell.stopped`:
  // interrupting a turn and ending the agent are different events to be answering for.
  | "cell.closed"
  // A new agent, and the posture it was born with. That posture was once the one property
  // of a cell that could not be changed afterwards; since 2026-09-09 it can, and the move
  // is its own event below — so this records where a cell **started**, not where it is.
  | "cell.spawned"
  // A posture moved on a cell that is already running. Distinct from `cell.spawned` because
  // it answers a different question when something goes wrong: not what this agent was
  // allowed to do, but what it was allowed to do *by then*.
  | "cell.posture"
  | "auth.allowed"
  | "auth.rejected"
  | "command.invoked"
  | "command.completed"
  | "command.failed"
  | "dispatch.executed"
  | "dictation.requested"
  | "bridge.chat.sent"
  | "bridge.chat.received"
  | "bridge.command.requested"
  | "bridge.command.completed"
  | "bridge.chat.full_content"
  | "task.mutated"
  | "work.approved"
  | "work.aborted"
  | "work.completed"
  | "notification.delivered"
  | "notification.lagged";

export type Fields = Record<string, unknown>;

export interface Logger {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  audit(event: AuditEvent, fields?: Fields): void;
}

const VERBOSE_ONLY_EVENTS: ReadonlySet<AuditEvent> = new Set([
  "bridge.chat.full_content",
]);

export function createLogger(opts?: { sink?: LogSink; verbose?: boolean }): Logger {
  const sink = opts?.sink ?? defaultSink;
  const verbose = opts?.verbose ?? false;

  const emit = (
    level: "info" | "warn" | "error",
    category: "log" | "audit",
    event: string,
    fields: Fields | undefined,
  ): void => {
    sink(JSON.stringify({ ts: Date.now(), level, category, event, ...fields }));
  };

  return {
    info(event, fields) {
      emit("info", "log", event, fields);
    },
    warn(event, fields) {
      emit("warn", "log", event, fields);
    },
    error(event, fields) {
      emit("error", "log", event, fields);
    },
    audit(event, fields) {
      if (!verbose && VERBOSE_ONLY_EVENTS.has(event)) return;
      emit("info", "audit", event, fields);
    },
  };
}

function defaultSink(line: string): void {
  process.stdout.write(line + "\n");
}
