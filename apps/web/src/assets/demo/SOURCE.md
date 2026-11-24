# Demo imagery — original, generated for this site

| File | What | Source |
|---|---|---|
| `canvas-wallpaper.webp` | the CodeCanvas wallpaper in the live demo — a voxel lake village at night, made for the app's "Lantern Night" theme (lapis duotone, warm light only on the lanterns) | generated in Pencil (`mockups/generated-2.png`), 1376×768, WebP q80 |
| `music-cover.webp` | cover art in the demo's Music node | generated in Pencil (`mockups/generated-1.png`), 320×320, WebP q74 |

Both are original art made for this page. The wallpaper is block-built like a voxel game, but
it is not taken from one: no game assets, no logos, no characters. The track title and channel shown beside the cover are placeholders, not a real release.

## Size budget — a hard cap, not a guideline

**~500 KB per asset, ~2 MB total** across everything in `src/assets/` (these two total ~48 KB).
Every committed byte stays in git history forever. The cap effectively rules out a
hero video; use AVIF/WebP stills. Do not quietly exceed it, and do not weaken an asset to fit it.
(Moved here from `src/assets/hero/BUDGET.md` when that now-empty folder was removed.)
