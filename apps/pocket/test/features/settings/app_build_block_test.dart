import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/settings/widgets/app_build_block.dart';
import 'package:lotus_pocket/models/app_build.dart';

void main() {
  test('label is the store convention release.sh prints', () {
    expect(const AppBuild(version: '1.2.0', buildNumber: 29850748).label, '1.2.0 (29850748)');
  });

  test('detail puts the commit first and skips what a hand build cannot know', () {
    expect(AppBuildBlock.describe(const AppBuild(version: '1.0.0', buildNumber: 1)), 'dev');

    final at = DateTime.utc(2026, 10, 3, 16, 28);
    final local = at.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    expect(
      AppBuildBlock.describe(AppBuild(
        version: '1.0.0',
        buildNumber: 29850748,
        commit: '997b9c90',
        builtAt: at,
        channel: 'sideload',
      )),
      '997b9c90 · built ${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)} · sideload',
    );
  });

  testWidgets('shows the running build', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: const Scaffold(
        body: AppBuildBlock(
          running: AppBuild(version: '1.0.0', buildNumber: 29850748, commit: 'abc12345'),
        ),
      ),
    ));

    expect(find.text('Lotus Pocket 1.0.0 (29850748)'), findsOneWidget);
    expect(find.textContaining('abc12345'), findsOneWidget);
  });
}
