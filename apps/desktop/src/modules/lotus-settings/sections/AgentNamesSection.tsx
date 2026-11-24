"use client";
import { Check, ChevronRight, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Radio } from "@/components/ui/radio";
import { MinMeter, Tag } from "@/components/ui/status";
import { TagInput } from "@/components/ui/tag-input";
import {
  addPoolNames,
  BUILT_IN_NAME_POOLS,
  deleteCustomPool,
  MIN_POOL_NAMES,
  namesForPool,
  replacePoolName,
  saveCustomPool,
  setActiveNamePool,
  useAgentNamingSettings,
  type CustomNamePool,
  type NameRejection,
} from "@/lib/agent-naming";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";

/**
 * Settings › Agents › Agent names (plans/agent-naming slice 03, mockups/agent-naming-v3.html):
 * one list. The radio picks the pool for every mode; a row opens in place, and your own pools are
 * edited there (click a name to change it). Every change saves on its own.
 */

const REJECTION_TEXT: Record<NameRejection["reason"], string> = {
  "invalid-char": "can only use letters, numbers, space, - and _.",
  "too-long": "is too long (32 characters at most).",
};

function sample(names: readonly string[], n: number): string {
  if (names.length === 0) return "No names yet";
  return names.slice(0, n).join(", ") + (names.length > n ? " …" : "");
}

type Row = { id: string; label: string; names: readonly string[]; builtIn: boolean };

export function AgentNamesSection() {
  const naming = useAgentNamingSettings();
  const [open, setOpen] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(0), 1400);
    return () => clearTimeout(timer);
  }, [saved]);

  const markSaved = () => setSaved(Date.now());
  const save = (pool: CustomNamePool) => {
    saveCustomPool(pool);
    markSaved();
  };
  const onDelete = (id: string) => {
    if (armed !== id) return setArmed(id);
    setArmed(null);
    deleteCustomPool(id);
    markSaved();
  };
  const newPool = (label = "New pool", names: readonly string[] = []) => {
    const id = crypto.randomUUID();
    save({ id, label, names: [...names] });
    setOpen(id);
  };
  const pick = (id: string) => {
    setActiveNamePool(id);
    markSaved();
  };

  const rows: Row[] = [
    ...BUILT_IN_NAME_POOLS.map((p) => ({ id: p.id as string, label: p.label, names: namesForPool(p.id), builtIn: true })),
    ...naming.customPools.map((p) => ({ ...p, builtIn: false })),
  ];

  return (
    <SettingsGroup
      title="Agent names"
      meta={
        saved ? (
          <span key={saved} className="ui-saved">
            <Check size={12} /> Saved
          </span>
        ) : null
      }
      description="New agents in Canvas, Code and Chat get a name from the pool you pick. Agents you already have keep their name."
      as="ul"
      action={
        <Button variant="secondary" size="sm" onClick={() => newPool()}>
          <Plus size={13} /> New pool
        </Button>
      }
    >
      <SettingRow
        as="li"
        selected={naming.active === "auto"}
        leading={<Radio checked={naming.active === "auto"} onChange={() => pick("auto")} label="Use Auto" />}
        label="Auto"
        description="Follows the device language"
      >
        {naming.active === "auto" ? <InUse /> : null}
      </SettingRow>
      {rows.map((p) => {
        const isOpen = open === p.id;
        const inUse = naming.active === p.id;
        const usable = p.builtIn || inUse || p.names.length >= MIN_POOL_NAMES;
        const toggle = () => setOpen(isOpen ? null : p.id);
        return (
          <SettingRow
            key={p.id}
            as="li"
            selected={inUse}
            expanded={isOpen}
            leading={
              <Radio
                checked={inUse}
                onChange={() => pick(p.id)}
                label={`Use ${p.label}`}
                disabled={!usable}
                title={usable ? undefined : `Needs ${MIN_POOL_NAMES} names`}
              />
            }
            label={
              <button type="button" className="inline-flex items-center gap-1.5 text-left" aria-expanded={isOpen} onClick={toggle}>
                {p.label || "Untitled pool"}
                {p.builtIn ? <Lock size={11} className="text-(--ui-ink-4)" aria-label="Built-in" /> : null}
              </button>
            }
            description={isOpen ? undefined : sample(p.names, 5)}
            body={
              p.builtIn ? (
                <BuiltInBody names={p.names} onCopy={() => newPool(`${p.label} (copy)`, p.names)} />
              ) : (
                <PoolBody pool={naming.customPools.find((c) => c.id === p.id)!} inUse={inUse} onSave={save} />
              )
            }
          >
            {inUse ? <InUse /> : null}
            <span className="ds-t-meta min-w-[2ch] text-right tabular-nums text-(--ui-ink-4)">{p.names.length}</span>
            {p.builtIn ? null : (
              <Button
                className="ui-row-reveal"
                variant={armed === p.id ? "danger" : "ghost"}
                size="sm"
                icon={armed !== p.id}
                aria-label={armed === p.id ? "Delete pool?" : `Delete ${p.label}`}
                onClick={() => onDelete(p.id)}
              >
                {armed === p.id ? <span className="ui-pop">Delete pool?</span> : <Trash2 size={13} />}
              </Button>
            )}
            <Button variant="ghost" size="sm" icon aria-expanded={isOpen} aria-label={isOpen ? `Close ${p.label}` : `Open ${p.label}`} onClick={toggle}>
              <ChevronRight size={14} className="ui-chevron" />
            </Button>
          </SettingRow>
        );
      })}
    </SettingsGroup>
  );
}

function InUse() {
  return (
    <span className="ui-pop">
      <Tag accent>In use</Tag>
    </span>
  );
}

function BuiltInBody({ names, onCopy }: { names: readonly string[]; onCopy: () => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <TagInput values={names} label="Names" />
      <div className="flex items-center gap-2 text-(--ui-ink-3)">
        <Lock size={12} />
        <span className="ds-t-meta flex-1">Built-in pools are locked.</span>
        <Button variant="secondary" size="sm" onClick={onCopy}>
          Copy and edit
        </Button>
      </div>
    </div>
  );
}

function PoolBody({ pool, inUse, onSave }: { pool: CustomNamePool; inUse: boolean; onSave: (pool: CustomNamePool) => void }) {
  const [label, setLabel] = useState(pool.label);
  const [rejected, setRejected] = useState<NameRejection | null>(null);
  const [shake, setShake] = useState(0);

  const apply = (result: { names: string[]; rejected: NameRejection | null }) => {
    setRejected(result.rejected);
    if (result.rejected) setShake(Date.now());
    if (result.names.join("\n") !== pool.names.join("\n")) onSave({ ...pool, names: result.names });
  };
  const short = pool.names.length < MIN_POOL_NAMES;

  return (
    <div className="flex flex-col gap-2.5">
      <Input
        aria-label="Pool name"
        value={label}
        placeholder="Pool name"
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label.trim() !== pool.label && onSave({ ...pool, label: label.trim() })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <TagInput
        values={pool.names}
        label="Add a name"
        placeholder={pool.names.length ? "Add a name" : "Type a name, or paste a list"}
        shake={shake}
        onAdd={(raw) => apply(addPoolNames(pool.names, raw))}
        onReplace={(i, raw) => apply(replacePoolName(pool.names, i, raw))}
        onRemove={(i) => apply({ names: pool.names.filter((_, j) => j !== i), rejected: null })}
      />
      <div className="ds-t-meta flex min-h-[18px] items-center gap-2.5 text-(--ui-ink-3)">
        {rejected ? (
          <span role="alert" className="text-(--ui-err)">
            &ldquo;{rejected.name}&rdquo; {REJECTION_TEXT[rejected.reason]}
          </span>
        ) : short ? (
          <>
            <MinMeter value={pool.names.length} min={MIN_POOL_NAMES} />
            <span>
              Add {MIN_POOL_NAMES - pool.names.length} more to use this pool.
              {inUse ? " Until then, new agents get Auto names." : ""}
            </span>
          </>
        ) : (
          <span>{pool.names.length} names · click a name to change it. Agents that already use a name keep it.</span>
        )}
      </div>
    </div>
  );
}
