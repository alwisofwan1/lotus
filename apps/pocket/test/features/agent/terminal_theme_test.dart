import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_surface.dart';

void main() {
  final t = AppTokens.dark;

  // The emulator paints the selection *over* the glyphs (`render.dart` paints it last), so
  // it must be see-through, and it must be far enough off the floor to be seen at all.
  // It was `t.raise`, one step off the background: a selection the operator could not
  // find on a phone in daylight (LOT2-104).
  group('the selection', () {
    final selection = terminalTheme(themeRegistry.first.dark.terminal).selection;

    test('lets the text under it through', () {
      expect(selection.a, inInclusiveRange(0.25, 0.5));
    });

    test('stands clear of the background it sits on', () {
      final over = Color.alphaBlend(selection, t.bg);
      final ratio = (over.computeLuminance() + 0.05) / (t.bg.computeLuminance() + 0.05);
      expect(ratio, greaterThan(2.5));
    });

    test('is not a grey — it reads as chosen, not as another raised row', () {
      final hsl = HSLColor.fromColor(selection);
      expect(hsl.saturation, greaterThan(0.3));
    });
  });
}
