import 'package:flutter/widgets.dart';

/// Turns an SVG `d` attribute into a [Path].
///
/// **Why this exists rather than `flutter_svg`.** The runner marks are seven static
/// silhouettes rendered at about 13 logical pixels. A full SVG renderer brings a parser
/// for gradients, masks, clip paths, text and CSS to do that, and ADR-9 ships this app
/// as a sideloaded APK where every dependency is weight the operator downloads. Forty
/// lines that handle exactly the commands the assets use is the smaller, more honest
/// answer.
///
/// **Why not redraw the marks by hand.** Because the `d` string is copied verbatim, a
/// mark cannot come out subtly wrong — and a subtly wrong vendor logo is worse than no
/// logo at all. What this file buys is fidelity, not convenience.
///
/// Supports `M L H V C Z` in their absolute forms, which is what
/// `apps/desktop/public/assets/ai-logo/*.svg` actually contains — verified across all
/// seven files before this was written, not assumed. Anything else **throws**, loudly,
/// at the moment the asset is introduced rather than silently rendering a mark with a
/// hole in it: a relative `c`, an arc `A`, a quadratic `Q` are all things a designer
/// might reasonably hand over next, and the failure has to name itself.
Path parseSvgPath(String d) {
  final path = Path();
  final tokens = _tokenise(d);
  var i = 0;
  var x = 0.0;
  var y = 0.0;

  double next() {
    final value = tokens[i++];
    return double.parse(value as String);
  }

  while (i < tokens.length) {
    final token = tokens[i++];
    switch (token) {
      case 'M':
        x = next();
        y = next();
        path.moveTo(x, y);
      case 'L':
        x = next();
        y = next();
        path.lineTo(x, y);
      case 'H':
        x = next();
        path.lineTo(x, y);
      case 'V':
        y = next();
        path.lineTo(x, y);
      case 'C':
        final x1 = next();
        final y1 = next();
        final x2 = next();
        final y2 = next();
        x = next();
        y = next();
        path.cubicTo(x1, y1, x2, y2, x, y);
      case 'Z':
      case 'z':
        path.close();
      default:
        throw FormatException(
          'svg_path: unsupported command "$token". This parser covers the absolute '
          'M L H V C Z that the shipped runner marks use. Add the command here — do '
          'not simplify the asset to fit.',
        );
    }
  }
  return path;
}

/// Splits a `d` string into commands and numbers.
///
/// SVG lets numbers run together where the sign or the decimal point is separator
/// enough — `1.5.5` is two numbers, `10-4` is two more — so this cannot be a plain
/// `split`. Numbers come back as strings and are parsed by the caller, which keeps the
/// command dispatch above readable.
List<Object> _tokenise(String d) {
  final out = <Object>[];
  final number = StringBuffer();

  void flush() {
    if (number.isEmpty) return;
    out.add(number.toString());
    number.clear();
  }

  for (var i = 0; i < d.length; i++) {
    final c = d[i];
    if (RegExp(r'[A-Za-z]').hasMatch(c)) {
      flush();
      out.add(c);
    } else if (c == ' ' || c == ',' || c == '\n' || c == '\t' || c == '\r') {
      flush();
    } else if (c == '-' && number.isNotEmpty && !number.toString().endsWith('e')) {
      // A minus that is not the first character starts the next number.
      flush();
      number.write(c);
    } else if (c == '.' && number.toString().contains('.')) {
      // A second dot in one run is the start of another number: `.5.5`.
      flush();
      number.write(c);
    } else {
      number.write(c);
    }
  }
  flush();
  return out;
}
