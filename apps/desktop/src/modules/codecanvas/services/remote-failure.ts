/**
 * What to tell an operator when a machine does not answer.
 *
 * The rule this file enforces comes from the mockup (screen 05) and from the ticket that locked it:
 * **every failure gets one sentence and one action.** A message that offers two possibilities and no
 * next step ("the host may be unreachable or authentication failed") makes the operator guess, and a
 * message that names our internals ("SSH master did not create control socket") makes them guess
 * about our code rather than their machine.
 *
 * The raw text is never thrown away — it is carried as `detail` so a real diagnosis is still one
 * glance away. It is just not the headline.
 */

export interface RemoteFailure {
  /** One sentence naming what happened, in the operator's terms. */
  title: string;
  /** The single thing to try next. */
  action: string;
  /** The underlying message, kept for when the summary is not enough. */
  detail: string;
}

interface Pattern {
  match: RegExp;
  title: (machine: string) => string;
  action: (machine: string) => string;
}

/**
 * Order matters, and one entry documents why: our own transport message names BOTH possibilities in
 * one sentence, so the rule that owns it has to be reached first.
 */
const PATTERNS: Pattern[] = [
  {
    // Our own exit-3 sentence from `fs_browse_ssh` is already written for an operator.
    match: /does not exist, or you do not have permission/i,
    title: () => "That folder could not be opened",
    action: () => "Go up one level, or pick another folder.",
  },
  {
    // Checked BEFORE the key patterns, and the ordering is a finding, not a preference: the
    // transport's own timeout message ends with "may be unreachable or authentication failed", so a
    // key-shaped rule placed first classifies an unreachable host as a rejected key and sends the
    // operator to ssh-copy-id for a machine that never answered. Reachable-or-auth is genuinely
    // ambiguous from here, so the action is the one command that tells them which — theirs to run.
    match: /control socket|did not create|timed out|timeout|connection closed|banner exchange/i,
    title: (machine) => `${machine} did not answer in time`,
    action: (machine) =>
      `Run ssh ${machine} in a terminal. If it asks you to sign in (for example Cloudflare Access), finish that first.`,
  },
  {
    match: /permission denied|publickey/i,
    title: (machine) => `${machine} rejected the key we have`,
    action: (machine) => `Run ssh-copy-id to ${machine}, then try again.`,
  },
  {
    match: /host key verification failed|known[_ ]hosts|remote host identification/i,
    title: (machine) => `We have not seen the fingerprint of ${machine} before`,
    action: (machine) =>
      `Open a terminal and run ssh ${machine} once to check and accept its fingerprint.`,
  },
  {
    match: /connection refused|could not resolve|name or service not known|no route to host/i,
    title: (machine) => `${machine} cannot be reached`,
    action: () => "Check the address and your network, then try again.",
  },
];

/**
 * Turn whatever came back from Rust into a headline, an action, and the raw detail.
 *
 * Unknown failures keep their own text as the headline rather than being flattened into a generic
 * apology: an unfamiliar message an operator can search for beats a friendly one that says nothing.
 */
export function describeRemoteFailure(raw: unknown, machine: string): RemoteFailure {
  const detail = raw instanceof Error ? raw.message : String(raw ?? "").trim();
  const text = detail || "No details available.";

  for (const pattern of PATTERNS) {
    if (pattern.match.test(text)) {
      return { title: pattern.title(machine), action: pattern.action(machine), detail: text };
    }
  }

  return {
    title: `Could not read the folder on ${machine}`,
    action: "Try again, or pick another folder.",
    detail: text,
  };
}

/**
 * Whether ssh itself could not get in — as opposed to getting in and then failing at something else
 * (a port forward, a folder, a hook).
 *
 * The machine status needs the difference: a failure to connect means nothing on the machine works,
 * while a failed forward only means agents stop reporting and terminals keep running. The folder
 * rule is left out because it can only come from a connection that worked.
 */
export function isConnectFailure(raw: unknown): boolean {
  const text = raw instanceof Error ? raw.message : String(raw ?? "");
  return PATTERNS.slice(1).some((pattern) => pattern.match.test(text));
}
