import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/host_api.dart' show SizeHold;
import 'package:lotus_pocket/features/agent/pty_size_lease.dart';

/// v4 tiket 11 — the phone holds the pane's size while Terminal is open, and stops for
/// the rest of the visit once someone at the desk takes it back.
void main() {
  late List<(int, int, int?)> holds;
  late List<int> releases;
  late SizeHold Function() answer;
  late PtySizeLease lease;

  setUp(() {
    holds = [];
    releases = [];
    answer = () => const SizeHold(held: true, token: 7);
    lease = PtySizeLease(
      hold: (cols, rows, token) async {
        holds.add((cols, rows, token));
        return answer();
      },
      release: (token) async => releases.add(token),
    );
  });

  // `testWidgets` for its fake clock: every timer here is driven by `pump`.
  testWidgets('holds once the area settles, then renews with the token', (tester) async {
    lease
      ..want(true)
      ..grid(54, 30)
      ..grid(54, 18); // the keyboard opening, mid-settle
    await tester.pump(PtySizeLease.settle);
    expect(holds, [(54, 18, null)]);

    await tester.pump(PtySizeLease.renewEvery);
    expect(holds.last, (54, 18, 7));
    lease.dispose();
  });

  testWidgets('leaving Terminal releases at once and stops renewing', (tester) async {
    lease
      ..want(true)
      ..grid(54, 30);
    await tester.pump(PtySizeLease.settle);
    lease.want(false);
    await tester.pump();
    expect(releases, [7]);

    await tester.pump(PtySizeLease.renewEvery * 3);
    expect(holds, hasLength(1));
  });

  testWidgets('a lost hold is final for the visit, and the next visit wins', (tester) async {
    lease
      ..want(true)
      ..grid(54, 30);
    await tester.pump(PtySizeLease.settle);
    answer = () => const SizeHold(held: false);
    await tester.pump(PtySizeLease.renewEvery);
    expect(holds, hasLength(2));

    lease.grid(44, 30); // even a new size does not take it back
    await tester.pump(PtySizeLease.renewEvery * 3);
    expect(holds, hasLength(2));
    expect(releases, isEmpty, reason: 'nothing is held, so nothing is released');

    answer = () => const SizeHold(held: true, token: 8);
    lease
      ..want(false)
      ..want(true);
    await tester.pump(PtySizeLease.settle);
    expect(holds.last, (44, 30, null), reason: 'a new visit starts a new lease');
    lease.dispose();
  });

  testWidgets('a host that could not be asked is tried again on the next renewal', (tester) async {
    var calls = 0;
    lease = PtySizeLease(
      hold: (cols, rows, token) async => ++calls == 1 ? null : const SizeHold(held: true, token: 3),
      release: (token) async => releases.add(token),
    )
      ..want(true)
      ..grid(54, 30);
    await tester.pump(PtySizeLease.settle);
    await tester.pump(PtySizeLease.renewEvery);
    expect(calls, 2);
    lease.dispose();
    await tester.pump();
    expect(releases, [3]);
  });

  testWidgets('nothing is sent before the area is known, or while not wanted', (tester) async {
    lease.grid(54, 30);
    await tester.pump(PtySizeLease.settle);
    lease.want(true);
    lease.want(false);
    await tester.pump(PtySizeLease.renewEvery);
    expect(holds, isEmpty);
  });
}
