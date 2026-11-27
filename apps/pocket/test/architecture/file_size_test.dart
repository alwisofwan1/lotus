import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// File-size and comment rules, shared with `packages/host` (see its CLAUDE.md).
/// Size counts code lines, so a comment never forces a split.
const int maxCodeLines = 600;
const int warnCodeLines = 400;
const int maxRawLines = 1000;
const int maxLineChars = 200;

/// A comment block longer than this belongs in an ADR or doc, not the file.
const int maxCommentBlock = 5;

/// Ratchet: how many over-long comment blocks lib/ still has. Lower it when you
/// trim comments; it must never go up.
const int longCommentBlockCeiling = 560;

bool isGenerated(String path) =>
    path.endsWith('.g.dart') || path.endsWith('.freezed.dart');

/// Non-blank lines outside `//`, `///` and `/* */` comments.
int codeLines(List<String> lines) {
  var count = 0;
  var inBlock = false;
  for (final raw in lines) {
    final s = raw.trim();
    if (inBlock) {
      if (s.contains('*/')) inBlock = false;
      continue;
    }
    if (s.isEmpty || s.startsWith('//')) continue;
    if (s.startsWith('/*')) {
      inBlock = !s.contains('*/');
      continue;
    }
    count++;
  }
  return count;
}

/// Runs of consecutive `//` lines longer than [maxCommentBlock].
int longCommentBlocks(List<String> lines) {
  var blocks = 0;
  var run = 0;
  for (final raw in [...lines, '']) {
    if (raw.trim().startsWith('//')) {
      run++;
      continue;
    }
    if (run > maxCommentBlock) blocks++;
    run = 0;
  }
  return blocks;
}

void main() {
  final files = Directory('lib')
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart') && !isGenerated(f.path))
      .toList();

  test('codeLines skips blanks and every comment form', () {
    expect(codeLines(['', '// a', '/// b', '/* c', 'd */', 'x;', '  y;']), 2);
  });

  test('longCommentBlocks counts only runs over the limit', () {
    final long = List.filled(maxCommentBlock + 1, '/// x');
    final short = List.filled(maxCommentBlock, '// x');
    expect(longCommentBlocks([...long, 'code;', ...short, 'code;', ...long]), 2);
  });

  test('files stay within $maxCodeLines code / $maxRawLines raw lines', () {
    final violations = <String>[];
    for (final file in files) {
      final lines = file.readAsLinesSync();
      final code = codeLines(lines);
      if (code > maxCodeLines) violations.add('${file.path}: $code code lines');
      if (lines.length > maxRawLines) {
        violations.add('${file.path}: ${lines.length} raw lines');
      }
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].length > maxLineChars) {
          violations.add('${file.path}:${i + 1} is ${lines[i].length} chars');
        }
      }
      if (code > warnCodeLines) {
        // ignore: avoid_print
        print('WARN ${file.path}: $code code lines, split at a seam soon');
      }
    }
    expect(violations, isEmpty);
  });

  test('long comment blocks never grow (ratchet)', () {
    final total = files.fold<int>(
        0, (sum, f) => sum + longCommentBlocks(f.readAsLinesSync()));
    expect(total, lessThanOrEqualTo(longCommentBlockCeiling),
        reason: 'new comment blocks over $maxCommentBlock lines: keep comments '
            'to one short "why"; move history to an ADR');
  });
}
