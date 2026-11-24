import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/pairing_outcome.dart';
import 'package:lotus_pocket/features/onboarding/pairing_diagnosis.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';
import 'package:lotus_pocket/models/cell.dart';

PairingDiagnosis diagnose(PairingOutcome outcome) => PairingDiagnosis.of(outcome)!;

void main() {
  test('a success has nothing to diagnose', () {
    final device = PairedDevice(
      deviceToken: 't',
      deviceId: 'd',
      expiresAt: DateTime(2026, 8, 9),
      hardExpiresAt: DateTime(2026, 9, 5),
      hostId: const HostId('mac'),
      hostLabel: 'MacBook',
      mode: 'client',
      caps: const HostCaps(protocol: 1, features: []),
      baseUri: Uri.parse('http://mac:8787'),
    );

    expect(PairingDiagnosis.of(PairingSucceeded(device)), isNull);
  });

  test('every failure names both what happened and what to do', () {
    final outcomes = <PairingOutcome>[
      const PairingAddressUnreadable('That is not an address.'),
      const PairingCodeRefused(),
      const PairingUnreachable(TailnetDown()),
      const PairingUnreachable(HostAsleep()),
      const PairingUnreachable(LotusNotRunning()),
      const PairingUnreachable(HostUnknownFailure()),
      const PairingHostFaulted('502'),
    ];

    for (final outcome in outcomes) {
      final diagnosis = diagnose(outcome);
      // A diagnosis with no next move is the thing this class exists to replace.
      expect(diagnosis.title, isNotEmpty, reason: outcome.code);
      expect(diagnosis.detail, isNotEmpty, reason: outcome.code);
    }
  });

  test('a refused code sends the operator to the desktop, not to the network', () {
    final diagnosis = diagnose(const PairingCodeRefused());

    // The phone reached the host and was told no. Mentioning the network here would
    // be the most expensive wrong turn on this screen.
    expect(diagnosis.detail, contains('code'));
    expect('${diagnosis.title} ${diagnosis.detail}'.toLowerCase(), isNot(contains('network')));
    expect('${diagnosis.title} ${diagnosis.detail}'.toLowerCase(), isNot(contains('tailscale')));
  });

  test('the four reachability causes read as four different situations', () {
    final said = [
      const TailnetDown(),
      const HostAsleep(),
      const LotusNotRunning(),
      const HostUnknownFailure(),
    ].map((f) => diagnose(PairingUnreachable(f)).title).toList();

    // `issues/06` requires them told apart; identical copy would make the taxonomy
    // decorative.
    expect(said.toSet(), hasLength(said.length));
  });

  test('a refused connection says the machine is fine and Lotus is not running', () {
    final diagnosis = diagnose(const PairingUnreachable(LotusNotRunning()));

    // The desktop makes the same distinction in `MobileTab.tsx`: the costly failure is
    // a machine that is up with nothing listening, and telling the operator to check
    // their network would send them to fix something that was never broken.
    expect(diagnosis.title.toLowerCase(), contains('awake'));
    expect(diagnosis.detail, contains('Lotus'));
  });

  test('a sleeping machine is told to be woken, not re-typed', () {
    expect(diagnose(const PairingUnreachable(HostAsleep())).detail, contains('Wake'));
  });

  test('an unusable answer is passed through, not paraphrased', () {
    // At this point the host's own words are the best diagnostic left.
    expect(diagnose(const PairingHostFaulted('HostFaulted(502): nginx')).detail,
        'HostFaulted(502): nginx');
  });
}
