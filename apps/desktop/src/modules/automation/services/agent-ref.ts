/**
 * An automation's agent: a saved preset plus the model, effort and Claude account picked on top,
 * stored as its `preset_id` — `<preset id>?model=…&effort=…&account=…`. Rust reads it in
 * `lotus_automation::agent::parse_agent_ref`, which allows only `[A-Za-z0-9.\-_:\[\]]` values.
 */
export type AgentRef = { presetId: string; model?: string; effort?: string; account?: string };

const KEYS = ["model", "effort", "account"] as const;

export function parseAgentRef(ref: string): AgentRef {
  const [presetId, query = ""] = ref.split("?", 2);
  const out: AgentRef = { presetId };
  for (const pair of query.split("&")) {
    const [key, value] = pair.split("=", 2);
    if (value && (KEYS as readonly string[]).includes(key)) out[key as (typeof KEYS)[number]] = value;
  }
  return out;
}

export function composeAgentRef({ presetId, ...choice }: AgentRef): string {
  const query = KEYS.filter((k) => choice[k]).map((k) => `${k}=${choice[k]}`);
  return query.length ? `${presetId}?${query.join("&")}` : presetId;
}

/** `args` with `flag` (`--flag v` or `--flag=v`) replaced by `flag value`; Rust's `agent::set_flag`. */
export function setFlag(args: string, flag: string, value: string): string {
  const tokens = args.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === flag) i++;
    else if (!tokens[i].startsWith(`${flag}=`)) out.push(tokens[i]);
  }
  return [...out, flag, value].join(" ");
}
