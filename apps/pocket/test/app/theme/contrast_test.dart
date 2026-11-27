import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/invariants/contrast.dart';

void main() {
  test('WCAG 2.1: black on white is 21:1, a colour on itself 1:1', () {
    expect(contrast(const Color(0xFF000000), const Color(0xFFFFFFFF)), closeTo(21, 1e-9));
    expect(contrast(const Color(0xFF777777), const Color(0xFF777777)), closeTo(1, 1e-9));
  });

  test('a translucent foreground is composited before measuring', () {
    const ground = Color(0xFF121214);
    expect(contrast(const Color(0xA0F7F2EA), ground), closeTo(7.06, 0.01));
    expect(contrast(const Color(0x79F7F2EA), ground), closeTo(4.52, 0.01));
  });

  test('OKLCH: amber is warm and chromatic, a neutral grey is not', () {
    final amber = oklch(const Color(0xFFFBBF24));
    expect(amber.h, inInclusiveRange(70, 90));
    expect(amber.c, greaterThan(0.15));
    expect(oklch(const Color(0xFF808080)).c, lessThan(0.001));
  });
}
