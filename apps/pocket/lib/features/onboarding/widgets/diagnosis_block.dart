import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../pairing_diagnosis.dart';

/// What went wrong with a pairing attempt.
///
/// **Two lines and no icon.** A red banner would say "error" where the useful thing to
/// say is which of four different situations this is — and `PairingDiagnosis` exists
/// precisely to tell them apart.
class DiagnosisBlock extends StatelessWidget {
  const DiagnosisBlock({required this.diagnosis, super.key});

  final PairingDiagnosis diagnosis;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          diagnosis.title,
          style: t.ui.copyWith(
            fontSize: 13.5,
            fontWeight: FontWeight.w600,
            height: 1.4,
            color: t.text,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          diagnosis.detail,
          style: t.ui.copyWith(fontSize: 12.5, height: 1.5, color: t.muted),
        ),
      ],
    );
  }
}
