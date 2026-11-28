import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/turn_progress.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_progress.dart';

void main() {
  testWidgets('the moving line stays under the current step, not across the card', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: const Scaffold(
        body: Center(
          child: SizedBox(
            width: 390,
            child: ProgressSteps(steps: [
              ProgressStep('Reading', ProgressState.now),
              ProgressStep('Changing', ProgressState.next),
            ]),
          ),
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 800));

    final label = tester.getRect(find.text('Reading'));
    final track = tester.getRect(find.byKey(const ValueKey('progress-sweep')));
    expect(track.left, moreOrLessEquals(label.left, epsilon: 0.5));
    expect(track.right, lessThanOrEqualTo(label.right + 0.5),
        reason: 'a track wider than its word drifts away from it (seen on the phone)');
  });
}
