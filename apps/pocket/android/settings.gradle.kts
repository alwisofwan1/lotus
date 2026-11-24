pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
    // Reads `app/google-services.json` into resources the Firebase SDK can find (ADR-4).
    //
    // Declared **here**, not in the root `build.gradle.kts` the Firebase console names:
    // that file has no `plugins {}` block at all in a Flutter project, because Flutter
    // declares plugin versions in this one. Adding a second mechanism to the root file
    // works often enough to be tempting and produces confusing resolution failures when
    // it does not.
    id("com.google.gms.google-services") version "4.5.0" apply false
}

include(":app")
