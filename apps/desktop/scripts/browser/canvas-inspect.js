/*
 * Lotus Canvas Browser — in-page inspection builder (single source of truth).
 *
 * This file is BOTH:
 *   1. `include_str!`'d into src-tauri/src/canvas_browser_snapshot.rs and injected
 *      (via webview.eval) into the remote page for snapshot/search capture, and
 *   2. imported-by-eval in scripts/browser/__tests__/canvas-inspect.test.mjs under
 *      jsdom so the accessibility-tree logic is unit-tested against a real DOM.
 *
 * Constraints that keep both call sites happy:
 *   - No ES `import`/`export` (must eval cleanly as an inline browser script).
 *   - Everything hangs off `globalThis.__lotusInspect`.
 *   - The builders are PURE w.r.t. the page: they read the DOM and populate a ref
 *     registry, but never navigate. The Rust wrapper appends the exfiltration.
 *
 * The snapshot format is a Playwright-MCP-style accessibility tree: indented
 * role + accessible-name lines, with `[ref=eN]` assigned to interactive elements
 * only. Refs are valid until the next page change (tracked by an epoch counter),
 * so an agent must re-snapshot after navigation before acting on a ref.
 */
(() => {
  const MAX_TREE_CHARS = 12000;
  const MAX_REFS = 200;
  const MAX_NAME = 180;

  const INTERACTIVE_SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=textbox]",
    "[role=combobox]",
    "[contenteditable=true]",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");

  const compact = (value, limit = MAX_NAME) =>
    String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);

  // High-precision secret patterns redacted from any page-derived string before
  // it enters the agent's context (defense-in-depth alongside the untrusted-
  // content demarcation). Deliberately narrow to avoid mangling real content.
  const SECRET_PATTERNS = [
    [/\b(bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, "$1 [REDACTED]"],
    [
      /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token)(["']?\s*[=:]\s*["']?)[A-Za-z0-9._~+/-]{6,}/gi,
      "$1$2[REDACTED]",
    ],
    [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, "[REDACTED_JWT]"],
    [/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-[REDACTED]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GH_TOKEN]"],
  ];

  const redactSecrets = (value) => {
    let out = String(value == null ? "" : value);
    for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
    return out;
  };

  // Page text is both whitespace-collapsed AND secret-redacted at the funnel.
  const safeText = (value, limit) => redactSecrets(compact(value, limit));

  // "Visible" here means not-deliberately-hidden, rather than positive layout
  // area: layout metrics are unreliable at capture time (and absent under the
  // jsdom test harness), whereas hidden/display/visibility are authoritative.
  const isVisible = (el) => {
    if (el.getAttribute && (el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
    if (el.hasAttribute && el.hasAttribute("hidden")) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle?.(el);
    if (style && (style.visibility === "hidden" || style.display === "none")) return false;
    return true;
  };

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };

  const HEADING_TAGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
  const IMPLICIT_ROLE = {
    a: "link", // only when href present, handled below
    button: "button",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    section: "region",
    ul: "list",
    ol: "list",
    li: "listitem",
    table: "table",
    img: "img",
    select: "combobox",
    textarea: "textbox",
  };

  const INPUT_ROLE = {
    checkbox: "checkbox",
    radio: "radio",
    button: "button",
    submit: "button",
    reset: "button",
    range: "slider",
    search: "searchbox",
    email: "textbox",
    text: "textbox",
    tel: "textbox",
    url: "textbox",
    password: "textbox",
    number: "spinbutton",
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (HEADING_TAGS[tag]) return "heading";
    if (tag === "a") return el.getAttribute("href") != null ? "link" : "generic";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLE[type] || "textbox";
    }
    return IMPLICIT_ROLE[tag] || "generic";
  };

  // Password fields never contribute their value; their accessible name comes
  // from label/placeholder only. (Value redaction is enforced server-side too.)
  const accessibleName = (el) => {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return compact(aria);
    const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      const parts = labelledby
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent);
      if (parts.length) return compact(parts.join(" "));
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") return compact(el.getAttribute("alt"));
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const id = el.getAttribute("id");
      if (id) {
        const label = el.ownerDocument.querySelector(`label[for="${CSS && CSS.escape ? CSS.escape(id) : id}"]`);
        if (label) return compact(label.textContent);
      }
      const wrapping = el.closest && el.closest("label");
      if (wrapping) return compact(wrapping.textContent);
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && type !== "password") {
        const val = el.getAttribute("value");
        if (val) return compact(val);
      }
      return compact(el.getAttribute("placeholder") || el.getAttribute("name") || "");
    }
    // Leaf-ish elements: use own text when it isn't dominated by children.
    return compact(el.textContent);
  };

  const isInteresting = (el, role) => {
    if (el.matches && el.matches(INTERACTIVE_SELECTOR)) return true;
    if (role === "heading") return true;
    if (["navigation", "main", "banner", "contentinfo", "form", "list", "listitem", "region", "img", "table"].includes(role)) {
      return true;
    }
    return false;
  };

  const resetRegistry = () => {
    globalThis.__lotusRefEpoch = (globalThis.__lotusRefEpoch || 0) + 1;
    globalThis.__lotusRefs = new Map();
    // Monotonic across snapshots: ref ids are NEVER reused, so a ref from an
    // earlier snapshot simply isn't in the current (cleared) registry — that is
    // how staleness is detected, without trusting the caller to echo an epoch.
    if (typeof globalThis.__lotusRefSeq !== "number") globalThis.__lotusRefSeq = 0;
    return globalThis.__lotusRefEpoch;
  };

  const registerRef = (el, epoch) => {
    globalThis.__lotusRefSeq += 1;
    const ref = `e${globalThis.__lotusRefSeq}`;
    const value = typeof WeakRef === "function" ? new WeakRef(el) : el;
    globalThis.__lotusRefs.set(ref, { value, epoch });
    return ref;
  };

  const buildTree = () => {
    const epoch = resetRegistry();
    const lines = [];
    let chars = 0;
    let refCount = 0;
    let truncated = false;

    const emit = (indent, line) => {
      if (truncated) return;
      const rendered = `${"  ".repeat(indent)}- ${line}`;
      if (chars + rendered.length + 1 > MAX_TREE_CHARS) {
        lines.push(`${"  ".repeat(indent)}- … (tree truncated)`);
        truncated = true;
        return;
      }
      lines.push(rendered);
      chars += rendered.length + 1;
    };

    const walk = (el, indent) => {
      if (truncated || !el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") return;

      const role = roleOf(el);
      const interesting = isInteresting(el, role);
      let childIndent = indent;

      if (interesting) {
        const name = redactSecrets(accessibleName(el));
        const interactive = el.matches && el.matches(INTERACTIVE_SELECTOR) && isVisible(el);
        let suffix = "";
        if (role === "heading") {
          const level = HEADING_TAGS[tag] || el.getAttribute("aria-level") || "";
          if (level) suffix += ` [level=${level}]`;
        }
        if (interactive && refCount < MAX_REFS) {
          const ref = registerRef(el, epoch);
          refCount += 1;
          suffix += ` [ref=${ref}]`;
        }
        const label = name ? `${role} "${name}"` : role;
        emit(indent, `${label}${suffix}`);
        childIndent = indent + 1;
      }

      for (const child of el.children) walk(child, childIndent);
    };

    const root = document.body || document.documentElement;
    if (root) for (const child of root.children) walk(child, 0);
    return { tree: lines.join("\n"), refEpoch: epoch, refCount, truncated };
  };

  // Legacy flat element list, kept for backward-compat with older consumers.
  const legacyElements = () =>
    Array.from(document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=link]"))
      .slice(0, 120)
      .map((el) => {
        const box = rectOf(el);
        // Never surface password values, even in the legacy element list.
        const isPassword = (el.getAttribute("type") || "").toLowerCase() === "password";
        const value = isPassword ? "" : el.value;
        return {
          tag: el.tagName.toLowerCase(),
          text: redactSecrets(compact(
            el.innerText || value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "",
          )),
          role: el.getAttribute("role") || null,
          href: el.href || null,
          name: el.getAttribute("name") || null,
          type: el.getAttribute("type") || null,
          visible: box.width > 0 && box.height > 0,
          box,
        };
      });

  const viewport = () => ({
    width: typeof innerWidth === "number" ? innerWidth : 0,
    height: typeof innerHeight === "number" ? innerHeight : 0,
    scrollX: typeof scrollX === "number" ? scrollX : 0,
    scrollY: typeof scrollY === "number" ? scrollY : 0,
  });

  const capturedAtIso = () => {
    try {
      return new Date().toISOString();
    } catch {
      return null;
    }
  };

  const buildSnapshotPayload = (requestId) => {
    const { tree, refEpoch, refCount, truncated } = buildTree();
    return {
      id: `canvas-snapshot-${requestId}`,
      action: "snapshot",
      requestId,
      url: location.href,
      title: document.title || "",
      text: safeText(document.body ? document.body.innerText : "", 12000),
      tree,
      refEpoch,
      refCount,
      truncated,
      elements: legacyElements(),
      viewport: viewport(),
      capturedAt: capturedAtIso(),
    };
  };

  // ── Action execution (slice I3) ──────────────────────────────────────────
  // Resolve a `[ref=eN]` from the snapshot registry, enforcing that it belongs
  // to the CURRENT snapshot epoch and still lives in the document. A ref from a
  // pre-navigation snapshot is rejected so the agent can never act on a stale
  // element (which in a real page could be a different, unexpected target).
  const resolveRef = (ref) => {
    const registry = globalThis.__lotusRefs;
    // Ref ids are monotonic and the registry is rebuilt each snapshot, so a ref
    // that isn't present is either never-valid or from a superseded snapshot.
    if (!ref || !registry || !registry.has(ref)) {
      return { error: `unknown or stale ref "${ref}" — take a new snapshot` };
    }
    const entry = registry.get(ref);
    if (entry.epoch !== globalThis.__lotusRefEpoch) {
      return { error: `stale ref "${ref}" — the page changed, take a new snapshot` };
    }
    const el = entry.value && typeof entry.value.deref === "function" ? entry.value.deref() : entry.value;
    if (!el || !el.isConnected) {
      return { error: `ref "${ref}" is no longer in the document — take a new snapshot` };
    }
    return { el };
  };

  const setNativeValue = (el, value) => {
    // React and other frameworks track value via a property setter; call the
    // native setter so their onChange fires, then dispatch input/change.
    const proto = Object.getPrototypeOf(el);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const typeInto = (el, text, submit) => {
    if (typeof el.focus === "function") el.focus();
    if (el.isContentEditable) {
      el.textContent = String(text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      setNativeValue(el, String(text));
    }
    if (submit) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      const form = el.form;
      if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }
  };

  const pressKeyOn = (el, key) => {
    const target = el || document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  };

  const selectOptions = (el, values) => {
    const wanted = new Set((Array.isArray(values) ? values : [values]).map(String));
    let matched = 0;
    for (const opt of Array.from(el.options || [])) {
      const on = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.text);
      opt.selected = on;
      if (on) matched += 1;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return matched;
  };

  // Perform one action and return a result payload carrying a FRESH snapshot so
  // the agent never acts twice on the same refs (buildSnapshot mints a new epoch).
  const performAction = (requestId, action) => {
    const result = { id: `canvas-action-${requestId}`, action: "action-result", requestId, ok: false };
    const kind = action && action.type;
    try {
      if (kind === "fill_form") {
        const fields = Array.isArray(action.fields) ? action.fields : [];
        const errors = [];
        for (const field of fields) {
          const r = resolveRef(field.ref);
          if (r.error) {
            errors.push(`${field.ref}: ${r.error}`);
            continue;
          }
          typeInto(r.el, field.value ?? "", false);
        }
        result.ok = errors.length === 0;
        result.filled = fields.length - errors.length;
        if (errors.length) result.error = errors.join("; ");
      } else if (kind === "press_key" && !action.ref) {
        pressKeyOn(null, String(action.key || ""));
        result.ok = true;
      } else {
        const r = resolveRef(action.ref);
        if (r.error) {
          result.error = r.error;
        } else {
          const el = r.el;
          if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
          switch (kind) {
            case "click":
              if (typeof el.focus === "function") el.focus();
              el.click();
              result.ok = true;
              break;
            case "type":
              typeInto(el, action.text ?? "", Boolean(action.submit));
              result.ok = true;
              break;
            case "select_option":
              result.matched = selectOptions(el, action.values ?? action.value ?? []);
              result.ok = result.matched > 0;
              if (!result.ok) result.error = "no matching option";
              break;
            case "press_key":
              pressKeyOn(el, String(action.key || ""));
              result.ok = true;
              break;
            default:
              result.error = `unknown action type "${kind}"`;
          }
        }
      }
    } catch (err) {
      result.ok = false;
      result.error = String((err && err.message) || err);
    }
    // Always attach a fresh snapshot of the resulting page state.
    result.snapshot = buildSnapshotPayload(requestId);
    return result;
  };

  globalThis.__lotusInspect = {
    // Exposed for unit testing; also usable by future action/console redaction.
    redactSecrets,
    performAction,
    buildSnapshot(requestId) {
      return buildSnapshotPayload(requestId);
    },

    buildSearch(requestId, query, maxResults) {
      const needle = compact(query, 240).toLowerCase();
      const cap = Math.min(Math.max(Number(maxResults) || 12, 1), 50);
      const results = [];
      const push = (entry) => {
        if (!entry || !entry.text) return;
        results.push({ ...entry, index: results.length });
      };
      if (needle) {
        const bodyText = compact(document.body ? document.body.innerText : "", 12000);
        const haystack = bodyText.toLowerCase();
        let from = 0;
        while (results.length < cap && from < haystack.length) {
          const idx = haystack.indexOf(needle, from);
          if (idx < 0) break;
          const start = Math.max(0, idx - 90);
          const end = Math.min(bodyText.length, idx + needle.length + 120);
          push({ kind: "text", text: redactSecrets(bodyText.slice(start, end)), score: 20, matchStart: idx, tag: "body", visible: true, box: null });
          from = idx + Math.max(needle.length, 1);
        }
        for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
          if (results.length >= cap) break;
          const box = rectOf(el);
          const tag = el.tagName.toLowerCase();
          const label = redactSecrets(accessibleName(el));
          const href = el.href || el.getAttribute("href") || null;
          const hay = `${label} ${href || ""} ${el.getAttribute("name") || ""} ${el.getAttribute("role") || ""}`.toLowerCase();
          if (!hay.includes(needle)) continue;
          const visible = box.width > 0 && box.height > 0;
          push({
            kind: "element",
            tag,
            text: label || href || tag,
            role: el.getAttribute("role") || null,
            href,
            name: el.getAttribute("name") || null,
            type: el.getAttribute("type") || null,
            visible,
            box,
            score: (visible ? 50 : 10) + (tag === "a" || tag === "button" ? 20 : 0),
          });
        }
      }
      results.sort((a, b) => (b.score || 0) - (a.score || 0));
      return {
        id: `canvas-search-${requestId}`,
        action: "search",
        requestId,
        query,
        url: location.href,
        title: document.title || "",
        totalResults: results.length,
        results: results.slice(0, cap),
        viewport: viewport(),
        capturedAt: capturedAtIso(),
      };
    },
  };
})();
