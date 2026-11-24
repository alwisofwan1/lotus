package com.serayu.lotus_pocket

import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// `FlutterFragmentActivity`, not `FlutterActivity`: `local_auth` hosts the biometric
// prompt in a `FragmentActivity`, and with the plain one the gate in front of every
// mutation (ADR-8) crashes at runtime rather than failing a test. The refresh key's own
// prompt (`RefreshKeyChannel`) needs the same.
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, RefreshKeyChannel.CHANNEL)
            .setMethodCallHandler(RefreshKeyChannel(this))
    }
}
