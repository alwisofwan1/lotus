/*
 * The page's motion (redesign 2026-11-21). A classic script from
 * /public because the CSP is `script-src 'self'` with no inline allowance, same as
 * download-os.js. No network calls.
 *
 * Without it every section is readable: all chapters at full contrast, the first scene
 * shown, both install panels listed. With it: the Story window follows the chapter in the
 * middle of the viewport, the phone plays once, install becomes tabs with Copy buttons.
 * The clipboard is written only when Copy is pressed, and never read.
 * Reduced motion keeps the scene switching (it is content) and skips reveals.
 */
(() => {
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.add("js");

  /* Story: the chapter crossing the middle of the viewport picks the window's scene. */
  const win = document.querySelector("[data-win]");
  if (win) {
    const chs = $$(".ch");
    const scenes = $$(".scene", win);
    const msw = win.querySelector("[data-msw]");
    const tabs = $$("[data-m]", msw);
    const status = win.querySelector("[data-status]");
    const pin = win.parentElement;
    const setMode = (m) => {
      const t = tabs.find((x) => x.dataset.m === m);
      msw.toggleAttribute("data-none", !t);
      tabs.forEach((x) => x.classList.toggle("on", x === t));
      if (!t) return;
      msw.style.setProperty("--x", `${t.offsetLeft - 3}px`);
      msw.style.setProperty("--w", `${t.offsetWidth}px`);
    };
    const show = (ch) => {
      const name = ch.dataset.scene;
      if (win.dataset.scene === name) return;
      win.dataset.scene = name;
      scenes.forEach((s) => s.classList.toggle("on", s.dataset.s === name));
      chs.forEach((c) => c.classList.toggle("on", c === ch));
      setMode(ch.dataset.mode);
      status.textContent = ch.dataset.status;
    };
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && show(e.target)), {
      rootMargin: "-45% 0px -45% 0px",
    });
    chs.forEach((c) => io.observe(c));
    // Below 900px the window keeps its 820px desktop layout and is scaled to the column.
    const fit = () => pin.style.setProperty("--k", String(Math.min(1, pin.clientWidth / 820)));
    const relayout = () => {
      fit();
      setMode(chs.find((c) => c.dataset.scene === win.dataset.scene)?.dataset.mode);
    };
    relayout();
    addEventListener("resize", relayout, { passive: true });
    document.fonts?.ready.then(relayout);
  }

  /* Scroll reveals: only what starts below the fold, so nothing visible ever blinks out. */
  if (!calm) {
    const rv = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.remove("pre"), rv.unobserve(e.target))),
      { threshold: 0.15 },
    );
    for (const el of $$("[data-reveal]")) {
      if (el.getBoundingClientRect().top > innerHeight) {
        el.classList.add("pre");
        rv.observe(el);
      }
    }
  }

  /* Pocket: play the phone once, when most of it is on screen. */
  const phone = document.querySelector("[data-phone]");
  if (phone && !calm) {
    const po = new IntersectionObserver(
      ([e]) => e.isIntersecting && (phone.classList.add("play"), po.disconnect()),
      { threshold: 0.5 },
    );
    po.observe(phone);
  }

  /* Install: tabs (Windows first when download-os.js put it first) and Copy buttons. */
  const box = document.querySelector("[data-tabs]");
  if (box) {
    const seg = box.querySelector('[role="tablist"]');
    const tabBtns = $$('[role="tab"]', seg);
    const pick = (on) =>
      tabBtns.forEach((t) => {
        t.setAttribute("aria-selected", String(t === on));
        t.tabIndex = t === on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = t !== on;
      });
    tabBtns.forEach((t, i) => {
      t.addEventListener("click", () => pick(t));
      t.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const next = tabBtns[(i + d + tabBtns.length) % tabBtns.length];
        pick(next);
        next.focus();
      });
    });
    seg.hidden = false;
    box.classList.add("tabbed");
    // download-os.js already decided the platform; this file reads nothing about the visitor.
    pick(tabBtns[document.querySelector('.dl[data-os="win"]') ? 1 : 0]);
  }
  for (const b of $$("[data-copy]")) {
    if (!navigator.clipboard) continue;
    b.hidden = false;
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.previousElementSibling.textContent);
        b.textContent = b.dataset.done;
      } catch {
        b.textContent = b.dataset.fail;
      }
      setTimeout(() => (b.textContent = b.dataset.label), 1500);
    });
  }
})();
