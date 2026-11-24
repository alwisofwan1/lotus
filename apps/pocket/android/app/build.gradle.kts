import java.util.Properties

plugins {
    id("com.android.application")
    // Must come after `com.android.application`, and it fails the build outright when
    // `google-services.json` is absent — which is the right failure: a build that
    // silently produced an app unable to receive wake-ups would be worse.
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/**
 * Release signing, read from `android/key.properties` — never from this file.
 *
 * The file and the keystore it points at are both gitignored, and the keystore lives
 * **outside the repository** (`~/.lotus-pocket/release.p12`) on purpose: a `git clean
 * -fdx` is a routine thing to run and would otherwise destroy the one artefact that
 * cannot be regenerated without consequence.
 *
 * Losing it does not lose the app — it loses the ability to *upgrade* an installed one.
 * Android identifies an app by package **and signature**, so a differently-signed build
 * of `com.serayu.lotus_pocket` installs only after uninstalling, which takes the paired
 * credential and every setting with it. Back this file up.
 */
val keyProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.serayu.lotus_pocket"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // The installed identity of the app, and the name `google-services.json` is
        // keyed by (ADR-4). Kept identical to `namespace` above: they are allowed to
        // differ — namespace names the generated `R`/`BuildConfig` package while this
        // names the installed app — and a difference between them only stores confusion.
        applicationId = "com.serayu.lotus_pocket"
        // **Pinned rather than inherited**, because 23 is a real constraint from a real
        // dependency: `flutter_secure_storage` declares `minSdkVersion = 23` for the
        // Keystore-backed `EncryptedSharedPreferences` that holds every device token
        // (ADR-5). Taking Flutter's default would hide that behind a number that moves
        // when the SDK is upgraded. `maxOf` keeps it correct if Flutter's floor ever
        // rises above ours.
        minSdk = maxOf(flutter.minSdkVersion, 23)
        targetSdk = flutter.targetSdkVersion
        // Both derived from `version:` in `pubspec.yaml` (`1.0.0+1` → name `1.0.0`,
        // code `1`). One source, so a release cannot ship a name and a code that
        // disagree — and `versionCode` is what Android compares on upgrade.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            // Absent config leaves this empty and the release build fails at signing
            // rather than silently falling back to the debug key. That fallback is the
            // template default and it is a trap: debug keys differ per machine and are
            // regenerated when `~/.android/debug.keystore` expires, so an "upgrade"
            // becomes INSTALL_FAILED_UPDATE_INCOMPATIBLE months later, far from the
            // decision that caused it.
            keyAlias = keyProperties.getProperty("keyAlias")
            keyPassword = keyProperties.getProperty("keyPassword")
            storePassword = keyProperties.getProperty("storePassword")
            keyProperties.getProperty("storeFile")?.let { storeFile = file(it) }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")

            // R8 on both halves. `isShrinkResources` needs `isMinifyEnabled`, and
            // enabling it without keep rules is how plugin reflection breaks — so the
            // rules in `proguard-rules.pro` are there, and the release APK is smoke-run
            // on a device before it is called done (`scripts/release.sh`).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )

            // Stated rather than assumed: a debuggable release would let any process on
            // the device attach to an app holding device tokens.
            isDebuggable = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
