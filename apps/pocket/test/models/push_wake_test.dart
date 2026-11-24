import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/push_wake.dart';

void main() {
  group('PushWake.fromMessage', () {
    test('reads the host contract: kind and paneId in data, words in the notification', () {
      final wake = PushWake.fromMessage(
        data: {'kind': 'finished', 'paneId': 'p-1'},
        title: 'Atlas',
        body: 'finished',
      );

      expect(wake!.kind, WakeKind.finished);
      expect(wake.paneId, 'p-1');
      expect(wake.sentence, 'Atlas finished');
    });

    test('is null for a frame this app does not know — an unknown kind or no pane', () {
      expect(PushWake.fromMessage(data: {'kind': 'weather', 'paneId': 'p-1'}), isNull);
      expect(PushWake.fromMessage(data: {'kind': 'attention'}), isNull);
      expect(PushWake.fromMessage(data: {'kind': 'attention', 'paneId': ''}), isNull);
    });

    test('falls back to generic words when the notification block is missing', () {
      // A data-only frame (the app open in the foreground on some platforms) still
      // has to read as a sentence, not as a blank banner.
      final wake = PushWake.fromMessage(data: {'kind': 'attention', 'paneId': 'p-1'});

      expect(wake!.sentence, 'An agent needs you');
    });
  });
}
