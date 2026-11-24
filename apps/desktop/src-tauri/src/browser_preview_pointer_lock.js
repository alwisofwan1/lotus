// Chat Preview: the Pointer Lock API, done by Lotus. WKWebView refuses pointer lock unless the app's
// UI delegate grants it, and wry has no hook for that, so a page that waits for the lock (a 3D game's
// mouse look) never starts. This grants it: `pointerLockElement` is set, `pointerlockchange` fires,
// the cursor is hidden, and Lotus is told (a cancelled `lotus-preview-lock://on|off` navigation) to
// freeze the system cursor, as Safari does for a real lock, so mouse movement never stops at a screen
// edge. Esc or leaving the page releases it, as in a browser.
(() => {
  if (window.__lotusPointerLock) return;
  window.__lotusPointerLock = true;
  let locked = null;
  const hide = document.createElement("style");
  hide.textContent = "*, *::before, *::after { cursor: none !important; }";
  const set = (element) => {
    if (element === locked) return;
    const was = locked;
    locked = element;
    if (!was !== !element) {
      if (element) document.documentElement.appendChild(hide);
      else hide.remove();
      window.location.href = `lotus-preview-lock://${element ? "on" : "off"}`;
    }
    queueMicrotask(() => document.dispatchEvent(new Event("pointerlockchange")));
  };
  Object.defineProperty(Document.prototype, "pointerLockElement", {
    configurable: true,
    get() {
      return locked;
    },
  });
  Element.prototype.requestPointerLock = function requestPointerLock() {
    set(this);
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = () => set(null);
  window.addEventListener("keydown", (event) => event.key === "Escape" && set(null), true);
  window.addEventListener("blur", () => set(null));
  window.addEventListener("pagehide", () => set(null));
})();
