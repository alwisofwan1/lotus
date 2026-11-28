import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/plan_notice.dart';

int epoch(DateTime t) => t.millisecondsSinceEpoch ~/ 1000;

void main() {
  final now = DateTime(2026, 11, 28, 10, 0); // a Saturday

  test('a warning with no reset time', () {
    expect(planNoticeWords('five_hour plan limit: allowed_warning.', now: now), 'Close to the 5-hour limit');
  });

  test('the reset time is local, never epoch seconds', () {
    final today = epoch(DateTime(2026, 11, 28, 14, 0));
    expect(
      planNoticeWords('five_hour plan limit: rejected. Resets at $today.', now: now),
      '5-hour limit reached · resets at 14:00',
    );
  });

  test('within a week it names the day; beyond, the date', () {
    final tue = epoch(DateTime(2026, 12, 1, 9, 5));
    expect(
      planNoticeWords('seven_day plan limit: allowed_warning. Resets at $tue.', now: now),
      'Close to the 7-day limit · resets Tue 09:05',
    );
    final later = epoch(DateTime(2026, 12, 12, 14, 0));
    expect(
      planNoticeWords('seven_day plan limit: rejected. Resets at $later.', now: now),
      endsWith('resets 12 Dec 14:00'),
    );
  });

  test('an unknown window or status still reads, without underscores', () {
    expect(planNoticeWords('some_window plan limit: odd_state.', now: now), 'Some window limit: odd state');
  });

  test('any other line is left alone', () {
    expect(planNoticeWords('Interrupted'), isNull);
  });
}
