"use client";

import { Eye, Lock, Pencil, Plug, Plus, Sparkles, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { foldNames, kitRefusal, type KitName, type RoleKit } from "../services/factory-agents";

// What one agent gets, drawn as tiles on wires into the agent: skills enter from the left, MCP servers
// from the right, so the side carries the kind and there is no legend. This is also the editor: an own
// tile has a × and the dashed tile at the bottom of each side adds one.
//
// - A WIRE IS A NAME THE RUN WILL RESOLVE. Drawn from `roleKit` (kit.rs wanted()): a shared name is
//   edited in "Shared by all roles", so its tile has no ×; a name this Mac lacks is red, its wire is
//   still, and the runner's own refusal sits under the map.
// - MOTION IS A QUIET LOOP (the user asked for it to always run). A comet crosses each wire, then rests
//   before the next pass, staggered per wire. It is decorative: Settings does not know whether a run
//   is using a capability. Reduced motion draws no comets at all.
// - FIXED ROWS. Tiles have a fixed height, so every wire's end is arithmetic, not a measurement.

const ROW = 44;
const GAP = 14;
const HUB = 88;
const WIRE = 96;
const WIDTH = WIRE * 2 + HUB;
const COL = 168;
const TOTAL = COL * 2 + WIDTH;
const LABEL_ROOM = 44;
const MIN_HEIGHT = 168;

const rowsHeight = (n: number) => (n === 0 ? 0 : n * ROW + (n - 1) * GAP);

type Kind = "skills" | "mcp";

interface Wire {
  key: string;
  d: string;
  state: "own" | "shared" | "missing" | "add";
  side: "left" | "right";
}

export function FactoryCapabilityMap({
  label,
  model,
  access,
  icon,
  kit,
  canEdit,
  live = false,
  onRemove,
  onAdd,
  picker,
  ownCaption = "this role",
}: {
  /** The agent's name: a role, or "All roles" for the shared set. */
  label: string;
  /** Its model line; null where the map is not about one model. */
  model: string | null;
  /** Null for the shared set, which has no access of its own. */
  access: "full" | "read-only" | null;
  icon: ReactNode;
  kit: RoleKit;
  /** Adding needs the catalog of this Mac. */
  canEdit: boolean;
  /** A run is using these capabilities now: the comets loop. Not wired yet. */
  live?: boolean;
  onRemove: (kind: Kind, name: string) => void;
  onAdd: (kind: Kind) => void;
  /** The open picker, drawn over the map. */
  picker?: ReactNode;
  /** What an own tile says under its name: "this role", or "every role" on the shared set. */
  ownCaption?: string;
}) {
  const id = useId();
  // The map is drawn at a fixed size and scaled down to the pane it sits in, never up.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setScale(Math.min(1, Math.max(0.5, el.clientWidth / TOTAL)));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const left = foldNames(kit.skills);
  const right = foldNames(kit.mcp);
  const leftRows = left.shown.length + (left.hidden ? 1 : 0) + 1;
  const rightRows = kit.noMcp ? 1 : right.shown.length + (right.hidden ? 1 : 0) + 1;
  const height = Math.max(MIN_HEIGHT, rowsHeight(leftRows), rowsHeight(rightRows));
  const cy = height / 2;
  const rowY = (rows: number, i: number) => (height - rowsHeight(rows)) / 2 + i * (ROW + GAP) + ROW / 2;

  const wires: Wire[] = [];
  const stateOf = (n: KitName): Wire["state"] => (n.missing ? "missing" : n.shared ? "shared" : "own");
  const leftWire = (key: string, y: number, state: Wire["state"]) =>
    wires.push({ key, state, side: "left", d: `M0 ${y} C${WIRE / 2} ${y} ${WIRE / 2} ${cy} ${WIRE} ${cy}` });
  const rightWire = (key: string, y: number, state: Wire["state"]) =>
    wires.push({ key, state, side: "right", d: `M${WIDTH} ${y} C${WIDTH - WIRE / 2} ${y} ${WIDTH - WIRE / 2} ${cy} ${WIDTH - WIRE} ${cy}` });
  left.shown.forEach((n, i) => leftWire(`skills:${n.name}`, rowY(leftRows, i), stateOf(n)));
  if (left.hidden) leftWire("skills:more", rowY(leftRows, left.shown.length), "add");
  leftWire("skills:add", rowY(leftRows, leftRows - 1), "add");
  if (kit.noMcp) rightWire("mcp:none", rowY(rightRows, 0), "add");
  else {
    right.shown.forEach((n, i) => rightWire(`mcp:${n.name}`, rowY(rightRows, i), stateOf(n)));
    if (right.hidden) rightWire("mcp:more", rowY(rightRows, right.shown.length), "add");
    rightWire("mcp:add", rowY(rightRows, rightRows - 1), "add");
  }

  const refusal = kitRefusal(label, kit);
  return (
    <div className="fa-capmap" data-live={live ? "true" : undefined} ref={box}>
      <div className="fa-capmap-fit" style={{ height: (height + LABEL_ROOM) * scale }}>
      <div className="fa-capmap-stage" style={{ height, transform: `scale(${scale})` }}>
        <div className="fa-capmap-col" data-side="left">
          <ul className="fa-capmap-side" aria-label={`Skills ${label} gets`}>
            {left.shown.map((n) => (
              <Row key={n.name} side="left" kind="skills" item={n} ownCaption={ownCaption} onRemove={onRemove} />
            ))}
            {left.hidden ? <MoreRow side="left" count={left.hidden} noun="skills" onClick={() => onAdd("skills")} /> : null}
          </ul>
          <AddRow side="left" label="Add skill" disabled={!canEdit} onClick={() => onAdd("skills")} />
        </div>
        <div className="fa-capmap-hub-cell" style={{ width: WIDTH, height }}>
          <svg className="fa-capmap-wires" width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} aria-hidden>
            <defs>
              <linearGradient id={`${id}-l`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={WIRE} y2="0">
                <stop offset="0" className="fa-capmap-stop-a" />
                <stop offset="1" className="fa-capmap-stop-b" />
              </linearGradient>
              <linearGradient id={`${id}-r`} gradientUnits="userSpaceOnUse" x1={WIDTH} y1="0" x2={WIDTH - WIRE} y2="0">
                <stop offset="0" className="fa-capmap-stop-a" />
                <stop offset="1" className="fa-capmap-stop-b" />
              </linearGradient>
            </defs>
            {wires.map((w, i) => (
              <g key={w.key}>
                <path className="fa-capmap-wire" data-state={w.state} d={w.d} />
                {w.state === "own" || w.state === "shared" ? (
                  <path
                    className="fa-capmap-comet"
                    d={w.d}
                    pathLength={100}
                    stroke={`url(#${id}-${w.side === "left" ? "l" : "r"})`}
                    style={{ animationDelay: `${i * 260}ms` }}
                  />
                ) : null}
              </g>
            ))}
          </svg>
          <div className="fa-capmap-hub" style={{ left: WIRE, top: cy - HUB / 2, width: HUB, height: HUB }}>
            <span className="fa-capmap-core">{icon}</span>
          </div>
          <div className="fa-capmap-hub-label" style={{ top: cy + HUB / 2 + 8 }}>
            <span className="fa-capmap-role">{label}</span>
            {access ? (
              <span className="fa-capmap-access" data-access={access}>
                {access === "full" ? <Pencil size={10} aria-hidden /> : <Eye size={10} aria-hidden />}
                {access === "full" ? "Full access" : "Read-only"}
              </span>
            ) : null}
            {model ? <span className="fa-capmap-model">{model}</span> : null}
          </div>
        </div>
        <div className="fa-capmap-col" data-side="right">
          <ul className="fa-capmap-side" aria-label={`MCP servers ${label} gets`}>
            {right.shown.map((n) => (
              <Row key={n.name} side="right" kind="mcp" item={n} ownCaption={ownCaption} onRemove={onRemove} />
            ))}
            {right.hidden ? <MoreRow side="right" count={right.hidden} noun="servers" onClick={() => onAdd("mcp")} /> : null}
            {kit.noMcp ? (
              <li className="fa-capmap-row" data-side="right" data-kind="none">
                <span className="fa-capmap-tile">
                  <Lock size={16} aria-hidden />
                </span>
                <span className="fa-capmap-label">
                  <span className="fa-capmap-name">no MCP</span>
                  <span className="fa-capmap-cap">triage reads only the ticket and code</span>
                </span>
              </li>
            ) : null}
          </ul>
          {kit.noMcp ? null : <AddRow side="right" label="Add server" disabled={!canEdit} onClick={() => onAdd("mcp")} />}
        </div>
      </div>
        {picker}
      </div>
      {refusal ? <p className="fa-capmap-refusal">{refusal}</p> : null}
    </div>
  );
}

function Row({ side, kind, item, ownCaption, onRemove }: { side: "left" | "right"; kind: Kind; item: KitName; ownCaption: string; onRemove: (kind: Kind, name: string) => void }) {
  const state = item.missing ? "missing" : item.shared ? "shared" : "own";
  const Icon = item.missing ? TriangleAlert : kind === "skills" ? Sparkles : Plug;
  const caption = item.missing ? "not on this Mac" : item.shared ? "shared" : ownCaption;
  const tile = (
    <span className="fa-capmap-tile" title={item.shared ? "Shared by all roles. Edit in Shared by all roles." : undefined}>
      <Icon size={17} aria-hidden />
      {item.shared ? <Lock className="fa-capmap-lock" size={9} aria-label="Shared by all roles" /> : null}
      {!item.shared ? (
        <button type="button" className="fa-capmap-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemove(kind, item.name)}>
          <X size={10} aria-hidden />
        </button>
      ) : null}
    </span>
  );
  const text = (
    <span className="fa-capmap-label">
      <span className="fa-capmap-name" title={item.name}>{item.name}</span>
      <span className="fa-capmap-cap">{caption}</span>
    </span>
  );
  return (
    <li className="fa-capmap-row" data-side={side} data-kind={state}>
      {side === "left" ? <>{text}{tile}</> : <>{tile}{text}</>}
    </li>
  );
}

function MoreRow({ side, count, noun, onClick }: { side: "left" | "right"; count: number; noun: string; onClick: () => void }) {
  const tile = <span className="fa-capmap-tile">+{count}</span>;
  const text = (
    <span className="fa-capmap-label">
      <span className="fa-capmap-name">{count} more</span>
      <span className="fa-capmap-cap">show all {noun}</span>
    </span>
  );
  return (
    <li data-side={side}>
      <button type="button" className="fa-capmap-row fa-capmap-button" data-side={side} data-kind="more" aria-label={`${count} more ${noun}, show the list`} onClick={onClick}>
        {side === "left" ? <>{text}{tile}</> : <>{tile}{text}</>}
      </button>
    </li>
  );
}

function AddRow({ side, label, disabled, onClick }: { side: "left" | "right"; label: string; disabled: boolean; onClick: () => void }) {
  const tile = (
    <span className="fa-capmap-tile">
      <Plus size={16} aria-hidden />
    </span>
  );
  const text = (
    <span className="fa-capmap-label">
      <span className="fa-capmap-name">{label}</span>
    </span>
  );
  return (
    <button type="button" className="fa-capmap-row fa-capmap-button" data-side={side} data-kind="add" disabled={disabled} onClick={onClick}>
      {side === "left" ? <>{text}{tile}</> : <>{tile}{text}</>}
    </button>
  );
}
