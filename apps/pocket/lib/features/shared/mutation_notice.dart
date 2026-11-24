import '../../data/mutation_outcome.dart';
import '../../hosts/host_failure.dart';

/// What to tell the operator after a mutation, in their words rather than the wire's.
///
/// Copy lives in `features/` because it is presentation — `data/` decides *what
/// happened* and refuses to have an opinion about how it reads. Null means "say nothing":
/// a dispatch that landed needs no confirmation, because the agent's own reply is the
/// confirmation and a toast on top of it would be noise.
///
/// Every branch names a **next move**, which is the test for whether the underlying
/// outcome deserved to exist at all.
String? noticeFor(MutationOutcome outcome, {required String agent}) => switch (outcome) {
      MutationSent() => null,
      // Not an error, and worded so: the gate did its job and nothing was sent.
      MutationRefused() => 'Not sent — the check was cancelled.',
      MutationNeedsPairing(:final cause) => _pairingNotice(cause),
      MutationNoLiveSession() => '$agent has already exited. Go back to refresh the list.',
      // The host's own words, unsoftened: a 400 is our bug, and hiding it behind
      // friendlier copy would hide the bug too.
      MutationRejected(:final reason) => 'The host refused it: $reason',
      // Not a refusal and not a fault: the desktop can only start an agent while a board
      // is open in its window, and that is a thing the operator can go and do.
      MutationHostNotReady() =>
        'Lotus is running, but no project is open in its window. Open one there, then try again.',
      MutationUnreachable(:final failure) => _unreachableNotice(failure),
      MutationUnknownHost() => 'This agent belongs to a host that is no longer paired.',
    };

String _pairingNotice(HostFailure? cause) => switch (cause) {
      CredentialRevoked() => 'This device was revoked from the desktop. Pair again to continue.',
      // Distinct wording from revoked on purpose: the operator did nothing wrong, and a
      // message implying otherwise sends them looking for a mistake that is just a clock.
      CredentialExpired() => 'Access expired while you were away. Pair again to continue.',
      _ => 'Access has run out. Pair again from the desktop to continue.',
    };

/// The failure taxonomy already decided what to do about each of these; this only puts
/// it into a sentence. Each names the machine-side action, because none of them can be
/// fixed from the phone.
String _unreachableNotice(HostFailure failure) => switch (failure) {
      // Read "it will pick this up when it wakes" until 2026-08-09, which promised a
      // mechanism that does not exist: `_retry` in `agent_page.dart` only runs on a tap,
      // there is no outbox anywhere in `data/`, and swiping to another cell clears the
      // held line outright. On Home it was worse — `Composer._send` clears the field
      // before the outcome is known, so the text was already gone when the sentence
      // claimed it was on its way.
      //
      // It also contradicted this file's own division of labour, which `agent_page.dart`
      // states where the two are shown together: the line carries the retry, the snackbar
      // names the cause. So this names the cause and the machine-side action, like its
      // three siblings, and promises nothing on the phone's behalf.
      HostAsleep() => 'That machine is asleep — wake it, then send again.',
      LotusNotRunning() => 'The machine answered, but Lotus is not running on it.',
      TailnetDown() => 'No route to that machine — check Tailscale.',
      _ => 'Could not reach that machine.',
    };
