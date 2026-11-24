import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/pairing_invite.dart';

/// The envelope a pairing QR arrives in.
///
/// Everything here is about refusing payloads rather than reading them, which is the
/// point: a scanner reports whatever is in front of the camera, so this is the only
/// place standing between "a barcode exists" and "dial this address with this code".
void main() {
  PairingInvite readOk(String scanned) {
    final reading = readInvite(scanned);
    expect(reading, isA<InviteReadable>(), reason: 'expected $scanned to be readable');
    return (reading as InviteReadable).invite;
  }

  InviteUnreadable refuse(String scanned) {
    final reading = readInvite(scanned);
    expect(reading, isA<InviteUnreadable>(), reason: 'expected $scanned to be refused');
    final refused = reading as InviteUnreadable;
    // Every refusal has to leave a way forward. The typed fields are still on screen
    // and still work, and a scan that only said "no" would send the operator looking
    // for a setting that does not exist.
    expect(refused.detail, isNotEmpty);
    return refused;
  }

  group('what the desktop publishes', () {
    test('reads the address and the code back out', () {
      final invite = readOk('lotus-pair://invite?v=1&address=192.168.1.11%3A8787&code=75447516');

      // The address survives as the exact string the desktop printed, colon and all —
      // `readAddress` is what turns it into a URI, and this must not pre-empt it.
      expect(invite.address, '192.168.1.11:8787');
      expect(invite.code, '75447516');
    });

    test('a field this build does not know is ignored, not fatal', () {
      // Forward compatibility within a version: adding a field must not brick older
      // phones, or the version number would have to move for every additive change and
      // every such move locks out a phone that was working an hour earlier.
      final invite = readOk(
        'lotus-pair://invite?v=1&address=a%3A1&code=2&label=MacBook&future=x',
      );
      expect(invite.address, 'a:1');
      expect(invite.code, '2');
    });

    test('an IPv6 host keeps its brackets through the round trip', () {
      final invite = readOk('lotus-pair://invite?v=1&address=%5Bfd7a%3A1%5D%3A8787&code=1');
      expect(invite.address, '[fd7a:1]:8787');
    });
  });

  group('payloads that are not ours', () {
    test('a foreign scheme is refused', () {
      expect(refuse('https://example.com/?v=1&address=a%3A1&code=2').title,
          contains('not a Lotus'));
    });

    test('bare text from any other barcode is refused', () {
      expect(refuse('WIFI:S:cafe;T:WPA;P:hunter2;;').title, contains('not a Lotus'));
    });

    test('empty input is refused without pretending it was a wrong code', () {
      expect(refuse('   ').title, contains('Nothing was read'));
    });

    test('our scheme with no version is refused', () {
      // The version is what makes the next case possible at all, so a payload without
      // one cannot be trusted to mean what its field names suggest.
      expect(refuse('lotus-pair://invite?address=a%3A1&code=2').title, contains('not a Lotus'));
    });
  });

  group('version', () {
    test('a newer payload says so, and names the way through', () {
      final refused = refuse('lotus-pair://invite?v=2&address=a%3A1&code=2');
      expect(refused.title, contains('newer Lotus'));
      // The fallback must be named: the typed fields still work, and an operator told
      // only "update the app" is stuck at a monitor with no way forward tonight.
      expect(refused.detail, contains('type the address'));
    });

    test('a non-numeric version is not our payload', () {
      expect(refuse('lotus-pair://invite?v=one&address=a%3A1&code=2').title,
          contains('not a Lotus'));
    });
  });

  group('incomplete payloads', () {
    test('a missing address is refused', () {
      expect(refuse('lotus-pair://invite?v=1&code=75447516').title, contains('incomplete'));
    });

    test('a missing code is refused', () {
      expect(refuse('lotus-pair://invite?v=1&address=a%3A1').title, contains('incomplete'));
    });

    test('whitespace-only fields count as missing', () {
      expect(refuse('lotus-pair://invite?v=1&address=%20&code=%20').title,
          contains('incomplete'));
    });
  });

  test('the code is not length-checked here — the host owns that rule', () {
    // Deliberate: `PAIRING_CODE_LENGTH` lives on the host, it refuses in one round
    // trip, and a second copy of the number in the app is a second thing to keep in
    // step. A short code must reach the host and come back refused, not be rejected
    // here by a rule that could drift.
    expect(readOk('lotus-pair://invite?v=1&address=a%3A1&code=42').code, '42');
  });
}
