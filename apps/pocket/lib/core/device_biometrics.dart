import 'package:local_auth/local_auth.dart';

import 'biometrics.dart';

/// Let the gate handle plugin errors so failures cannot bypass proof (ADR-1, ADR-10).
class DeviceBiometrics implements Biometrics {
  DeviceBiometrics({LocalAuthentication? auth}) : auth = auth ?? LocalAuthentication();

  /// Injected collaborator, kept visible (ADR-13 no. 4).
  final LocalAuthentication auth;

  /// `isDeviceSupported` rather than `canCheckBiometrics`: the second is false on a
  /// phone with a passcode but no enrolled fingerprint, and answering "this device has
  /// no lock" there would hand ADR-12 no. 4's exception to the one situation an
  /// attacker can arrange.
  @override
  Future<bool> get canPrompt => auth.isDeviceSupported();

  @override
  Future<bool> prompt(String reason) => auth.authenticate(
        localizedReason: reason,
        // Passcode counts — see the note on [Biometrics.canPrompt].
        biometricOnly: false,
        // The OS backgrounds the app while its own sheet is up; without this the prompt
        // fails rather than resuming, and the operator sees a mutation refused for a
        // reason they never caused.
        persistAcrossBackgrounding: true,
      );
}
