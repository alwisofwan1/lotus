import 'dart:math' as math;

import 'package:flutter/painting.dart';

/// WCAG 2.1 contrast of [fg] composited over an opaque [bg], with alphaBlend's float math.
double contrast(Color fg, Color bg) {
  final a = relativeLuminance(Color.alphaBlend(fg, bg));
  final b = relativeLuminance(bg);
  final (hi, lo) = a > b ? (a, b) : (b, a);
  return (hi + 0.05) / (lo + 0.05);
}

/// Relative luminance per WCAG 2.1. Expects an opaque colour.
double relativeLuminance(Color c) {
  double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/// OKLCH of an opaque colour: lightness 0..1, chroma, hue in degrees.
({double l, double c, double h}) oklch(Color color) {
  double lin(double v) => v <= 0.04045 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  final r = lin(color.r), g = lin(color.g), b = lin(color.b);
  double cbrt(double v) => math.pow(v, 1 / 3).toDouble();
  final l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  final m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  final s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  final ll = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  final aa = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  final bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  final h = math.atan2(bb, aa) * 180 / math.pi;
  return (l: ll, c: math.sqrt(aa * aa + bb * bb), h: h < 0 ? h + 360 : h);
}

/// Euclidean distance in OKLab between two opaque colours.
double deltaEok(Color x, Color y) {
  final p = oklch(x), q = oklch(y);
  final pa = p.c * math.cos(p.h * math.pi / 180), pb = p.c * math.sin(p.h * math.pi / 180);
  final qa = q.c * math.cos(q.h * math.pi / 180), qb = q.c * math.sin(q.h * math.pi / 180);
  return math.sqrt(math.pow(p.l - q.l, 2) + math.pow(pa - qa, 2) + math.pow(pb - qb, 2));
}

/// Smallest angle between two hues, 0..180.
double hueGap(double a, double b) {
  final d = (a - b).abs() % 360;
  return d > 180 ? 360 - d : d;
}
