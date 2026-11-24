import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Holds the test window like a phone, upright.
///
/// The default test window is 800×600 — **landscape** — and landscape Terminal is full
/// screen (v4 tiket 10), which hides the header most Agent tests tap. A test about the
/// turned phone sets its own size after this.
void holdUpright(WidgetTester tester) {
  if (tester.view.physicalSize.width <= tester.view.physicalSize.height) return;
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}
