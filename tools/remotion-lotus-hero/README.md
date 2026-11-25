# `remotion-lotus-hero`

The two-surface explainer video for [`apps/web`](../../apps/web) — CodeSpace, then
CodeCanvas. 1920×1080, 30 fps, 42 s.

Decided in the website planning notes (`plans/lotus-web/issues/07`) and built on a product
analysis (`research/codespace-codecanvas-analysis.md`); both are kept outside this public repo.

```bash
bun install
bun run studio            # interactive, for iterating on timing
bun run render:preview    # half scale — use this while iterating, it is ~4x faster
bun run render            # out/lotus-demo.mp4
bun run still             # out/hero.png, frame 735
```

`out/` is gitignored (root `.gitignore:33`). Nothing rendered here is committed.

## What this is, and what it is deliberately not

It is a **reconstruction of the product's own interface**, drawn in Remotion from the
app's real palette (`src/styles/canvas-theme.ts`), its `void` dot background, its
floating node windows, its NL command bar. It is **not** a screen recording, and it must
never be captioned as one.

That distinction is narrower than the first cut assumed, and worth writing down, because
getting it wrong cost a whole render. The first cut banned window chrome outright,
reasoning that chrome would make an animation feel like a fake screencast. The result was
a generic architecture diagram that looked nothing like Lotus — and it was *less*
truthful, not more, because the thing being described was a visual product and the video
refused to show what it looks like. The rule from
`issues/06` §7 is **never
claim what is not real**. Depicting the real UI honours that rule; hiding it does not.

So the chrome is in: top bar with workspace tabs, node title bars with
`icon name · runner` and the `⤢ ⇱ ✕` controls, the zoom cluster, the real agent names
this repo actually runs with (`Bima · Codex`, `Nara · Claude Code`), and the Music node,
which is real and is the last thing anyone expects in a coding tool. What stays out is
anything that would pass it off as a capture: no cursor, no fake click, no OS furniture
beyond the window itself, and no voice-over calling it a recording.

Every beat is a mechanism that exists in the source. Nothing is invented:

| Beat | Where it comes from |
|---|---|
| Context chips: `charge.ts`, `unsaved`, `~/work/payments-api`, `3 cells` | real fields on `codespace/services/bridge/context-collector.ts` |
| Node windows, dot canvas, NL bar, zoom cluster | `src/styles/canvas-theme.ts` + the canvas surface |
| `lotus_dispatch_to_cell → Nara` | a real MCP tool name, `scripts/lotus-mcp-server.mjs` |
| NL command matched locally, no model tokens | the canvas command bar's fast path |
| Handoff edges (N2) | `CONTEXT.md`, Canvas Agent Node wiring |
| Context node (N3) | `canvas.ts` — *"visual surface of one Shared Context Bus"* |
| Critic, verdict, gate closing (N4) | `canvas.ts` — *"emits a boolean verdict; a FAIL closes the gate"* |
| Human gate `idle → waiting → approved` | `canvas.ts` — *"pauses a Workflow Run until the user approves or rejects"* |

If any of those change in the product, this video becomes a lie. There is no test
watching it — unlike the site's copy, which
[`apps/web/test/facts-match-source.test.ts`](../../apps/web/test/facts-match-source.test.ts)
does guard. **Re-check this file against that test's assertions before re-publishing.**

## Four decisions worth not re-litigating

**Window heights are computed against line counts, never eyeballed.** Two separate
renders shipped clipped content: Nara's last two lines — the punchline the caption was
pointing at — fell outside `overflow: hidden`, and the pipeline nodes at 78 px tall ate
their own status pill, so the `approved` beat rendered as an empty box. Both were
invisible in the source and obvious in the frame. **Extract frames and look at them
before every full render**; that is the only step that has ever caught this.

**The FAIL beat stays.** A cut that only showed the happy path would be selling a
diagram tool. The gate *closing* is the reason the graph is worth drawing, so the
critic fails once, the N4 edge goes red and dashed, the gate stays `idle` — and only
then does the second attempt pass.

**The graph is drawn before it runs.** Critic and gate appear with the rest of the
board; only their *status* changes over time. An earlier cut introduced them at the
moment they were needed, which left the FAIL caption saying "the gate closes" while
no gate was on screen. Drawing the whole board first is both honest and a better
argument — it is what the headline claims.

**`T.fail` is the one colour added beyond the site's palette.** The site has no red
because it never had to show a verdict. Amber was rejected for FAIL: amber already
means "a human is needed", and reusing it for "verification failed" would blunt the
single meaningful colour in the brand. It is kept at the same low saturation as the
others, so it reads as instrument rather than alarm.

## Publishing

The mp4 is **4.4 MB**, far over the ~500 KB asset budget in
`issues/05` §2,
so it cannot be a git asset. Host it externally and point the site's demo CTA at the
URL — that path was written into `issues/07` before this tool existed.

`out/hero.png` is **~1 MB at 1920×1080**, which does *not* fit the budget either — the
dense canvas frame compresses far worse than the near-empty one it replaced. It is *not*
currently used: the hero's live HTML simulation beats a static PNG there, because it
is theme-aware, crisp at every viewport, and readable by a screen reader. Keep the
still for places that need a flat image.
