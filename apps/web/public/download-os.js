// Puts the visitor's platform first in components/DownloadButtons.astro. A classic,
// render-blocking file (not inline: the CSP is script-src 'self'; not a module: those are
// deferred) so the swap lands before first paint and never shows as a layout shift.
// `null` (Linux, phones, tablets, unknown) leaves both links as they are.
function pickOs(platform, ua, touchPoints) {
  var s = platform + " " + ua;
  if (/android|iphone|ipad|mobi/i.test(s)) return null;
  // iPadOS reports itself as a Mac; a Mac has no multi-touch screen.
  if (/mac/i.test(s)) return touchPoints > 1 ? null : "mac";
  if (/win/i.test(s)) return "win";
  return null;
}

if (typeof document !== "undefined") {
  (function () {
    var el = document.currentScript && document.currentScript.previousElementSibling;
    var uad = navigator.userAgentData;
    var os = pickOs((uad && uad.platform) || "", navigator.userAgent, navigator.maxTouchPoints || 0);
    if (!el || !os) return;
    el.querySelectorAll("[data-os]").forEach(function (a) {
      a.classList.toggle("btn-ghost", a.getAttribute("data-os") !== os);
    });
    el.setAttribute("data-os", os);
  })();
}
