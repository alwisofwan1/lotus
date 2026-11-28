"use client";

import { Check, ChevronLeft, MessageCirclePlus, X } from "lucide-react";
import { useState } from "react";

import type { Automation, AutomationClient } from "../services/automation-api";
import { savedBy, sentAgo, watchSteps, type AgentWatchHost, type Watch } from "../services/agent-watch";
import { agentPromptFor, TEMPLATES } from "../services/templates";
import { TemplateIconView } from "./BrowseTab";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/** A template's request, as the person would say it: "Every weekday at 09:00 sends me …". */
function asSaid(request: string): string {
  const said = request.replace(/^Create a Lotus automation that\s+/i, "");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * "New automation" in the Dock (`.pen` 16e v2): describe it, and watch it build. Before anything is
 * sent it is the composer — one field, ⌘↵ — with three examples under it. Once sent, the request
 * stays as a sent message and three steps follow the agent the host opened; the next step is the
 * only action. Closing the Dock leaves the agent running: the watch is kept by the surface.
 */
export function DockNew({
  host,
  onCreateWithAgent,
  automations,
  client,
  watch,
  onWatch,
  onBack,
  onOpen,
}: {
  host?: AgentWatchHost;
  onCreateWithAgent?: (prompt: string) => Promise<string | null>;
  automations: Automation[];
  client: AutomationClient;
  watch: Watch | null;
  onWatch: (watch: Watch | null) => void;
  onBack: () => void;
  onOpen: (automationId: string) => void;
}) {
  const shortcut = useFormatShortcut();
  const [text, setText] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = Boolean(host || onCreateWithAgent);

  const send = async () => {
    const request = text.trim();
    if (!request || opening || !canCreate) return;
    setOpening(true);
    setError(null);
    const before = automations.map((a) => a.id);
    try {
      if (host) {
        const opened = await host.create(agentPromptFor(request));
        if ("error" in opened) setError(opened.error);
        else {
          onWatch({ request, agent: opened, sentAtMs: Date.now(), before });
          setText("");
        }
      } else if (onCreateWithAgent) {
        const why = await onCreateWithAgent(agentPromptFor(request));
        if (why) setError(why);
        else {
          setText("");
          onBack();
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(false);
    }
  };

  const header = (
    <header className="au-dhead au-dhead--back">
      <button type="button" className="au-dock-backlink" aria-label="Back" onClick={onBack}>
        <ChevronLeft size={15} strokeWidth={1.75} aria-hidden />
        New automation
      </button>
    </header>
  );

  if (watch) {
    const saved = savedBy(watch, automations);
    const alive = host?.alive(watch.agent.id) ?? false;
    const asking = !saved && alive && (host?.asking?.(watch.agent.id) ?? false);
    const steps = watchSteps(watch, { alive, saved, asking });
    const working = !saved && alive;
    return (
      <>
        {header}
        <div className="au-main-scroll">
          <div className="au-main-inner au-dnew">
            <div className="au-dnew-sent" aria-label="Your request">
              <p className="au-dnew-request">{watch.request}</p>
              <span className="au-dnew-meta">
                Sent to {watch.agent.name} · {sentAgo(watch.sentAtMs)}
              </span>
            </div>
            <ol className="au-dsteps" aria-label="Progress">
              {steps.map((step) => (
                <li key={step.id} className="au-dstep" data-state={step.state} data-asking={step.id === "working" && asking ? "" : undefined}>
                  <span className="au-dstep-mark" aria-hidden>
                    {step.state === "done" ? <Check size={11} strokeWidth={2.5} /> : step.state === "failed" ? <X size={11} strokeWidth={2.5} /> : <span className="au-dstep-pulse" />}
                  </span>
                  <span className="au-dstep-text">
                    <span className="au-dstep-title">{step.title}</span>
                    <span className="au-dstep-sub">{step.sub}</span>
                  </span>
                  {step.id === "working" && step.state === "active" && host ? (
                    asking ? (
                      <button
                        type="button"
                        className="rs-button rs-button--primary au-dstep-action"
                        onClick={() => (host.answer ? host.answer(watch.agent.id) : host.show(watch.agent.id))}
                      >
                        Answer
                      </button>
                    ) : (
                      <button type="button" className="rs-button au-dstep-action" onClick={() => host.show(watch.agent.id)}>
                        Show on canvas
                      </button>
                    )
                  ) : null}
                  {step.id === "saved" && saved ? (
                    saved.enabled ? (
                      <button type="button" className="rs-button au-dstep-action" onClick={() => onOpen(saved.id)}>
                        Open
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="rs-button rs-button--primary au-dstep-action"
                        onClick={() => void client.setEnabled(saved.id, true).catch((e: unknown) => setError(String(e)))}
                      >
                        Turn on
                      </button>
                    )
                  ) : null}
                </li>
              ))}
            </ol>
            {error ? (
              <p className="au-error" role="alert">
                {error}
              </p>
            ) : null}
            <footer className="au-dnew-foot">
              {working ? (
                <>
                  <span className="au-hint">Closing the Dock leaves {watch.agent.name} running.</span>
                  <button type="button" className="au-qfoot-discard" onClick={() => host?.close(watch.agent.id)}>
                    Close terminal
                  </button>
                </>
              ) : (
                <button type="button" className="rs-button" onClick={() => onWatch(null)}>
                  <MessageCirclePlus size={13} aria-hidden />
                  Describe another
                </button>
              )}
            </footer>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="au-main-scroll">
        <div className="au-main-inner au-dnew">
          <div className="au-dnew-compose">
            <textarea
              className="au-composer-input"
              aria-label="Describe an automation"
              placeholder="Every Monday at 08:00, DM me the PRs I still owe a review…"
              rows={4}
              autoFocus
              value={text}
              disabled={opening}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="au-dnew-compose-foot">
              <span className="au-hint">
                {canCreate ? "An agent opens on the canvas, asks what it needs, and saves it switched off." : "Open a workspace first: the agent needs somewhere to run."}
              </span>
              <button type="button" className="rs-button rs-button--primary" disabled={!canCreate || !text.trim() || opening} onClick={() => void send()}>
                {opening ? "Opening agent…" : "Create with agent"}
                <kbd className="au-kbd">{shortcut("⌘↵")}</kbd>
              </button>
            </div>
          </div>
          {error ? (
            <p className="au-error" role="alert">
              {error}
            </p>
          ) : null}
          <section className="au-dsec" aria-label="Examples">
            <h2 className="au-dsec-title">Or start from an example</h2>
            <ul className="au-dexamples">
              {TEMPLATES.slice(0, 3).map((t) => (
                <li key={t.id}>
                  <button type="button" className="au-dexample" onClick={() => setText(asSaid(t.request))}>
                    <span className="au-dexample-icon" aria-hidden>
                      <TemplateIconView icon={t.icon} size={14} />
                    </span>
                    <span className="au-dexample-text">
                      <span className="au-dexample-title">{t.title}</span>
                      <span className="au-dexample-sub">{t.when}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
