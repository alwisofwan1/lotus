#!/usr/bin/env node
//
// Regenerates `lib/features/shared/runner_marks.g.dart` from the shared SVG marks.
//
//   node apps/pocket/scripts/generate-runner-marks.mjs
//
// **Why generate instead of copying the SVGs into `assets/`.** Two reasons, and neither
// is about saving bytes. The marks are already checked in once, at
// `apps/desktop/public/assets/ai-logo/` — copying them makes a second source that will
// drift the first time one is updated. And bundling them as assets would mean shipping a
// parser for gradients, masks and text to draw seven static silhouettes, which ADR-9's
// sideloaded APK pays for on every download.
//
// The path data is emitted **verbatim**. Nothing here simplifies, re-fits or re-draws a
// mark: a subtly wrong vendor logo is worse than no logo, so the only transformation is
// reading `d` out of the file and quoting it.
//
// This runs by hand, not in a build. Pocket does not depend on the desktop package and
// this script does not create that dependency — it is a developer tool that happens to
// read a file, and its output is checked in.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../../desktop/public/assets/ai-logo');
const OUT = resolve(here, '../lib/features/shared/runner_marks.g.dart');

/// What the host calls a runner (`Cell.agentType`) → the file that draws it.
///
/// `codex` maps to the OpenAI mark because Codex is OpenAI's CLI and the asset set has
/// no Codex-specific logo. Stated here rather than assumed silently: if a Codex mark
/// ever lands, this is the one line that changes.
const RUNNERS = {
  claude: 'Claude.svg',
  codex: 'ChatGPT.svg',
  cursor: 'Cursor.svg',
  gemini: 'Gemini.svg',
  grok: 'Grok.svg',
  kimi: 'Kimi.svg',
};

// `Opencode.svg` is deliberately absent. It is a 300×300 two-tone mark built from a
// `mask` and a `clipPath` with two different fills — not a single silhouette, so it
// cannot take the one colour this design gives it. Flattening it would be redrawing it.

function extract(file) {
  const svg = readFileSync(join(SOURCE, file), 'utf8');

  const viewBox = svg.match(/viewBox=["']([^"']+)["']/);
  if (!viewBox) throw new Error(`${file}: no viewBox`);
  const [minX, minY, width, height] = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (minX !== 0 || minY !== 0) throw new Error(`${file}: viewBox origin must be 0 0`);
  if (width !== height) throw new Error(`${file}: viewBox must be square, got ${width}×${height}`);

  // Every `d` in the file, in document order. `Kimi.svg` also carries a
  // `<rect stroke="black">` — a bounding box left in by the exporter, not part of the
  // mark — and taking only `<path d=...>` drops it without a special case.
  const paths = [...svg.matchAll(/<path\b[^>]*\sd=["']([^"']+)["']/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error(`${file}: no <path d=...>`);

  const unsupported = [...paths.join(' ').matchAll(/[A-Za-z]/g)]
    .map((m) => m[0])
    .filter((c) => !'MLHVCZz'.includes(c));
  if (unsupported.length) {
    throw new Error(
      `${file}: uses path commands the Dart parser does not cover: ` +
        `${[...new Set(unsupported)].join(', ')}. Extend lib/features/shared/svg_path.dart ` +
        `rather than simplifying the asset.`,
    );
  }

  return { size: width, paths };
}

const known = new Set(readdirSync(SOURCE).filter((f) => f.endsWith('.svg')));
const entries = [];
for (const [runner, file] of Object.entries(RUNNERS)) {
  if (!known.has(file)) throw new Error(`${file} is missing from ${SOURCE}`);
  const { size, paths } = extract(file);
  entries.push({ runner, file, size, paths });
  console.log(`  ${runner.padEnd(8)} ${file.padEnd(14)} ${size}×${size}  ${paths.length} path(s)`);
}

const body = entries
  .map(
    ({ runner, file, size, paths }) =>
      `  // ${file}\n` +
      `  '${runner}': RunnerMark(\n` +
      `    viewBox: ${size},\n` +
      `    paths: <String>[\n` +
      paths.map((d) => `      '${d.replace(/'/g, "\\'")}',\n`).join('') +
      `    ],\n` +
      `  ),`,
  )
  .join('\n');

writeFileSync(
  OUT,
  `// GENERATED FILE — do not edit by hand.
//
// Run \`node apps/pocket/scripts/generate-runner-marks.mjs\` to refresh it from
// \`apps/desktop/public/assets/ai-logo/\`, which stays the one place these marks live.
//
// The \`d\` strings are copied verbatim from those files. Editing them here would make
// this app draw a vendor's logo slightly differently from every other surface that
// draws it, which is the failure the generator exists to prevent.

/// One runner's silhouette, as the SVG describes it.
class RunnerMark {
  const RunnerMark({required this.viewBox, required this.paths});

  /// Width and height of the square the coordinates are expressed in.
  final double viewBox;

  /// Sub-paths, in document order, filled with the non-zero rule the source assumes.
  final List<String> paths;
}

/// Keyed by \`Cell.agentType\`, lowercased.
const Map<String, RunnerMark> kRunnerMarks = <String, RunnerMark>{
${body}
};
`,
  'utf8',
);

console.log(`\n▸ wrote ${OUT}`);
