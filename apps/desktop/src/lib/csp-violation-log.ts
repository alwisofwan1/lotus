import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Send each Content-Security-Policy violation to Rust (`csp_violation_log`), which appends it to
 * `<lotus state dir>/csp-violations.log`. The CSP only applies in a production build, where there
 * is no console to read, so a load the policy blocks would otherwise fail without a trace.
 *
 * Violations before this runs are kept by the inline `csp-violation-buffer` script in the root
 * layout (`self.__lotusCspViolations`) and sent first. Each distinct one is sent once.
 */

type Buffered = { directive: string; blocked: string; source: string };

declare global {
  interface Window {
    __lotusCspViolations?: Buffered[] | null;
  }
}

export function describeViolation(v: Buffered): string {
  return `${v.directive} blocked=${v.blocked || "(inline)"} at=${v.source}`;
}

export const CSP_VIOLATION_BUFFER_SCRIPT =
  "self.__lotusCspViolations=[];document.addEventListener('securitypolicyviolation',function(e){" +
  "var b=self.__lotusCspViolations;if(b&&b.length<50)b.push({directive:e.effectiveDirective," +
  "blocked:String(e.blockedURI||'').slice(0,200),source:String(e.sourceFile||'').slice(0,200)+':'+e.lineNumber})});";

export function installCspViolationLog(): () => void {
  if (typeof window === "undefined" || !isTauri()) return () => {};
  const seen = new Set<string>();
  const send = (v: Buffered) => {
    const line = describeViolation(v);
    if (seen.has(line) || seen.size >= 200) return;
    seen.add(line);
    void tauriInvoke<void>("csp_violation_log", { line }).catch(() => undefined);
  };
  const early = window.__lotusCspViolations ?? [];
  window.__lotusCspViolations = null;
  early.forEach(send);
  const onViolation = (event: SecurityPolicyViolationEvent) =>
    send({
      directive: event.effectiveDirective,
      blocked: String(event.blockedURI || "").slice(0, 200),
      source: `${String(event.sourceFile || "").slice(0, 200)}:${event.lineNumber}`,
    });
  document.addEventListener("securitypolicyviolation", onViolation);
  return () => document.removeEventListener("securitypolicyviolation", onViolation);
}
