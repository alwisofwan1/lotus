"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken part of Automations from blanking the rest. A card that throws (a draft from an
 * older engine with a field missing, say) takes down only its own region — the feed or the pane —
 * and says so, with a way to try again. The sidebar stays usable, so the user can step elsewhere.
 *
 * `resetKey` clears the error when what the region shows changes (another channel, another item),
 * so moving on is also a retry.
 */
export class AutomationBoundary extends Component<
  { region: string; resetKey?: string; children: ReactNode },
  { error: Error | null; key?: string }
> {
  state: { error: Error | null; key?: string } = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[automation] ${this.props.region} crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="au-boundary" role="alert">
        <strong>This part of Automations could not be shown.</strong>
        <span className="au-hint">{this.state.error.message || String(this.state.error)}</span>
        <button type="button" className="rs-button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
