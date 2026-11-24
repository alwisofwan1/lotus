import 'package:flutter/painting.dart';

import 'app_tokens.dart';

/// The three surfaces Pocket v4 adds: a control track, the terminal's own ground, and a
/// pressed key (`plans/pocket-chat-terminal-v4/PLAN.md` § Token desain).
///
/// **An extension rather than three more fields on [AppTokens]**, because that file is at
/// the 300-line ceiling (`layering_test.dart`) and its bulk is the contrast record on
/// `dim`, which is the part least worth moving. Constants are honest here for the reason
/// [AppTokens.dark] gives: it is the only instance, so there is nothing to lerp between.
/// The day a second theme exists these become fields, and every call site already reads
/// them as `t.termBg`, so none of them changes.
///
/// Solid rather than translucent like [AppTokens.raise]: each of these sits on a known
/// floor — the app's or the terminal's — and the mockup gives them as solid hexes.
extension SurfaceTokens on AppTokens {
  /// A track that holds controls — the Chat | Terminal switch. One step above [raise],
  /// since a [raise] track would read as the floor around a segment rather than a part.
  Color get raise2 => const Color(0xFF232325);

  /// The terminal's ground, and the header's while Terminal is shown. Darker than [bg] so
  /// switching reads as entering the pane, not as the same page re-coloured.
  Color get termBg => const Color(0xFF0A0A0B);

  /// A key cap on the extra-keys row (tiket 05).
  Color get key => const Color(0xFF2A2A2D);

  /// The chosen segment, and a key held down or locked.
  Color get keyHi => const Color(0xFF3A3A3E);
}
