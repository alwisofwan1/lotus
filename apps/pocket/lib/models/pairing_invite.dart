/// The scheme every Lotus pairing QR carries.
///
/// Namespaced rather than a bare `host:port code` payload, so a camera pointed at a
/// parcel label, a Wi-Fi QR or somebody's boarding pass is **refused here** instead of
/// being half-understood and dialled. A scanner sees whatever is in front of it; this
/// is the line where "a barcode" becomes "an invitation from Lotus".
const String pairingInviteScheme = 'lotus-pair';

/// The payload version this build reads.
///
/// Carried as a field rather than implied, because the failure it prevents is specific:
/// a newer desktop adding a field this build ignores would pair *almost* correctly, and
/// a pairing that half-works is worse than one that is refused with a reason.
const int pairingInviteVersion = 1;

/// The result of reading a scanned payload.
///
/// Two outcomes with the same shape as [AddressReading] in `data/pairing_address.dart`,
/// deliberately: both answer "can this become an address" before anything leaves the
/// phone, and an operator meeting both in one flow should meet one idiom.
sealed class InviteReading {
  const InviteReading();
}

class InviteReadable extends InviteReading {
  const InviteReadable(this.invite);

  final PairingInvite invite;
}

class InviteUnreadable extends InviteReading {
  const InviteUnreadable({required this.title, required this.detail});

  /// What happened, and what to do — the two halves `PairingDiagnosis` already renders
  /// side by side, so a refused scan reads exactly like a refused pairing rather than
  /// like a different kind of failure.
  ///
  /// Said in the operator's terms. Every one of these is read while they are holding a
  /// phone up to a monitor, so none of them names a scheme, a query parameter or a
  /// version number they cannot act on. And every [detail] names the typed fields,
  /// because those are still right there and still work.
  final String title;
  final String detail;
}

/// An address and a code, which is exactly what the typed form asks for.
///
/// **It carries no host label, and that is a deviation from ADR-5 with a reason.**
/// ADR-5's sketch put `hostLabel` in the payload so the phone could name the machine
/// before redeeming. There is no such moment here: a scan redeems immediately, and the
/// reply carries the host's real label a fraction of a second later. Putting a label in
/// the QR would mean shipping a second source of truth for a name, to be shown for less
/// time than it takes to read — so nothing produces one and nothing parses one.
class PairingInvite {
  const PairingInvite({required this.address, required this.code});

  /// `192.168.1.11:8787`, exactly the form the desktop already prints on screen.
  ///
  /// Kept as the raw string rather than a `Uri` so it goes through `readAddress` —
  /// the same function the typed field uses. One parser decides what an address means,
  /// which is why a scan and a typed entry cannot disagree about the same host.
  final String address;

  /// The pairing code, verbatim.
  ///
  /// Not length-checked here even though the host issues eight digits: the host owns
  /// that rule (`PAIRING_CODE_LENGTH`), it can refuse in one round trip, and a second
  /// copy of the number in this file is a second thing to keep in step.
  final String code;
}

/// Reads a scanned payload.
///
/// Strict about the envelope and incurious about the contents: the scheme and the
/// version are checked here because getting them wrong means the payload is not ours,
/// while the address and the code are handed on to the parts that already own them.
InviteReading readInvite(String scanned) {
  final trimmed = scanned.trim();
  if (trimmed.isEmpty) {
    return const InviteUnreadable(
      title: 'Nothing was read from that code.',
      detail: 'Fill the frame with the QR, or type the address and code below.',
    );
  }

  final Uri parsed;
  try {
    parsed = Uri.parse(trimmed);
  } on FormatException {
    return _notOurs;
  }

  // `Uri` lower-cases the scheme on parse, so this comparison needs no folding.
  if (parsed.scheme != pairingInviteScheme) return _notOurs;

  final version = int.tryParse(parsed.queryParameters['v'] ?? '');
  if (version == null) return _notOurs;
  if (version > pairingInviteVersion) {
    return const InviteUnreadable(
      title: 'That code is from a newer Lotus than this app.',
      detail: 'Update Lotus Pocket, or type the address and code below instead.',
    );
  }

  final address = parsed.queryParameters['address']?.trim() ?? '';
  final code = parsed.queryParameters['code']?.trim() ?? '';
  if (address.isEmpty || code.isEmpty) {
    return const InviteUnreadable(
      title: 'That Lotus code is incomplete.',
      detail: 'Ask the machine for a new one, or type the address and code below.',
    );
  }

  return InviteReadable(PairingInvite(address: address, code: code));
}

/// The one message for every "this is not a Lotus pairing code" case.
///
/// Bad syntax, a foreign scheme and a missing version are one fact from where the
/// operator stands — they pointed the camera at the wrong thing — and three different
/// sentences would only invite them to debug a payload they cannot see. The version
/// mismatch above is the exception, because that one has a different action.
const InviteUnreadable _notOurs = InviteUnreadable(
  title: 'That is not a Lotus pairing code.',
  detail: 'Show the QR from Settings → Mobile access → Pair a phone on the machine '
      'running Lotus.',
);
