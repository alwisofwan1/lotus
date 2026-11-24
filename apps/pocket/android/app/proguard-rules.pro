# R8 keep rules for the release build.
#
# Deliberately short. Every rule here is one this app was observed to need, not a
# defensive copy-paste — an over-broad `-keep class **` turns shrinking off in all but
# name, and then the APK carries code nothing calls while looking like it was optimised.
#
# The one thing this file cannot do is prove itself: a missing rule fails at *runtime*,
# in a code path R8 could not see. So `scripts/release.sh` installs the release APK and
# exercises the paths that use reflection before calling a build good.

# --- flutter_secure_storage (every device token, ADR-5) -----------------------------
# AndroidX Security resolves its crypto providers by name through Tink, so the classes
# are never referenced from code R8 can follow. Losing them does not fail the build; it
# fails the first read of the Keychain, which looks like an unpaired phone.
-keep class androidx.security.crypto.** { *; }
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# --- local_auth (the gate in front of every mutation, ADR-8) ------------------------
-keep class androidx.biometric.** { *; }

# --- firebase_messaging (background wake-ups, ADR-4) --------------------------------
# The service is named in the manifest and instantiated by the framework, so nothing in
# Dart or Kotlin refers to it.
-keep class com.google.firebase.messaging.** { *; }
-keep class io.flutter.plugins.firebase.messaging.** { *; }

# --- Flutter embedding ---------------------------------------------------------------
# Plugin registration is reflective (`GeneratedPluginRegistrant`).
-keep class io.flutter.embedding.** { *; }

# --- Google Play Core, which this app deliberately does not have ----------------------
# Found by the build failing, not by anticipating it: R8 stopped with
#
#   Missing class com.google.android.play.core.splitcompat.SplitCompatApplication
#   (referenced from: io.flutter.embedding.android.FlutterPlayStoreSplitApplication)
#
# Flutter's embedding carries a Play-Store variant of its Application class for deferred
# components / split installs. ADR-9 ships a sideloaded APK with no store, so Play Core
# is not a dependency and those classes genuinely are not there.
#
# `-dontwarn` rather than adding the dependency: pulling in Play Core to satisfy a code
# path this app can never take would grow the APK for nothing. The class is unreachable
# because `AndroidManifest.xml` names `${applicationName}` → `FlutterApplication`, not
# the Play Store one.
-dontwarn com.google.android.play.core.**
