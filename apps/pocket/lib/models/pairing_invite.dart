/// The namespace prevents unrelated QR codes from being dialled.
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

  /// Uses actionable operator-facing wording and names the typed fields.
  final String title;
  final String detail;
}

/// Omits a host label to avoid a second source of truth (ADR-5).
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

/// Groups invalid codes under one actionable message.
const InviteUnreadable _notOurs = InviteUnreadable(
  title: 'That is not a Lotus pairing code.',
  detail: 'Show the QR from Settings → Mobile access → Pair a phone on the machine '
      'running Lotus.',
);
