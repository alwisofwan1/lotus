import '../../data/pairing_outcome.dart';
import '../../hosts/host_failure.dart';

/// What a failed pairing attempt says on screen.
///
/// One sentence naming what happened, one naming what to do. Both are needed: the
/// goal named in `map.md` is a setup that is guided and whose **diagnostics name the
/// cause** — "could not connect" is the failure this is written against.
///
/// The desktop already reasons this way and its own words are worth matching, since
/// the operator reads both screens minutes apart: `MobileTab.tsx` calls the costly
/// case *"Running, but only this machine can reach it"* rather than an error, because
/// the expensive failure is never a host that is down — it is a host that is up,
/// bound to loopback, with every indicator green and no phone able to route to it.
///
/// **Provisional wording.** `issues/06` owns the final copy for the reachability
/// states and is blocked on `issues/02`, which needs a real machine put to sleep on a
/// real tailnet. What is *not* provisional is which states exist — those are types in
/// [PairingOutcome] and [HostFailure], so this file can be rewritten without anything
/// having to be rediscovered.
class PairingDiagnosis {
  const PairingDiagnosis({required this.title, required this.detail});

  /// What happened, in the operator's terms.
  final String title;

  /// What to do about it. Never empty: a diagnosis with no next move is the thing
  /// this class exists to replace.
  final String detail;

  /// Null for [PairingSucceeded] — there is nothing to diagnose, and the screen it
  /// belongs to has already been left behind.
  static PairingDiagnosis? of(PairingOutcome outcome) => switch (outcome) {
        PairingSucceeded() => null,
        PairingAddressUnreadable(:final reason) => PairingDiagnosis(
            title: reason,
            detail: 'Lotus shows the address under Mobile access, as host:port.',
          ),
        // Deliberately not phrased as a reachability problem: the phone reached the
        // host perfectly well and was told no. Sending the operator to check their
        // network here would be the most expensive wrong turn on this screen.
        PairingCodeRefused() => const PairingDiagnosis(
            title: 'That code did not work.',
            detail: 'A code lasts five minutes and works once. Ask the desktop for a new one.',
          ),
        // Neither a bad code nor a broken host: the code in the operator's hand may be
        // perfectly good. Waiting is the move, and it is the only case on this screen
        // that asks for it — so the detail is the host's own sentence, which is the
        // only side that knows whether this is ten seconds or a fresh code
        // (`packages/host/.../pair-route.ts`).
        PairingThrottled(:final reason) => PairingDiagnosis(
            title: 'That host is turning attempts away for now.',
            detail: '$reason Wait a moment, then try the same code again.',
          ),
        PairingUnreachable(:final failure) => _unreachable(failure),
        PairingHostFaulted(:final reason) => PairingDiagnosis(
            title: 'Something answered, but not as Lotus.',
            // The host's own words, unedited. At this point they are the best
            // diagnostic left, and paraphrasing them would throw away the only
            // evidence the operator has.
            detail: reason,
          ),
      };

  static PairingDiagnosis _unreachable(HostFailure failure) => switch (failure) {
        TailnetDown() => const PairingDiagnosis(
            title: 'No route to that address.',
            detail: 'Tailscale may be off, or that address belongs to a network this '
                'phone is not on.',
          ),
        HostAsleep() => const PairingDiagnosis(
            title: 'That machine did not answer.',
            detail: 'It is most likely asleep. Wake it, then try the same code — if it '
                'has been five minutes, ask for a new one.',
          ),
        // The one the desktop calls out too, and the reason "it failed" is not good
        // enough: a refused connection means the machine is awake and healthy, and
        // nothing about the network needs touching.
        LotusNotRunning() => const PairingDiagnosis(
            title: 'That machine is awake, but nothing is listening.',
            detail: 'Lotus is not running there, or Mobile access is switched off in '
                'its settings.',
          ),
        // Deliberately vague about WHY, because the handshake is: a rejected upgrade
        // arrives without its status code, so this is equally a stale code, a host mid
        // restart, or something in front of it saying no. Naming one would send the
        // operator to fix the wrong thing.
        HostRefused() => const PairingDiagnosis(
            title: 'Something there turned the connection down.',
            detail: 'The address is reachable and answering. Check the code has not '
                'expired, and that the host finished starting up.',
          ),
        // Reached only if a credential state is somehow routed here. Pairing has no
        // credential yet, so this cannot be diagnosed as one — saying so is more
        // honest than picking the nearest-sounding cause.
        CredentialExpired() || CredentialRevoked() || HostUnknownFailure() =>
          const PairingDiagnosis(
            title: 'Could not reach that address.',
            detail: 'The failure did not name itself. Check the address, then that '
                'Lotus is running.',
          ),
      };
}
