package com.serayu.lotus_pocket

import android.app.KeyguardManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager.Authenticators
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The hardware-bound refresh key behind `lib/core/refresh_keys.dart`.
 *
 * An EC P-256 key in Android Keystore that cannot sign until the operator proves presence
 * — the Keystore enforces that, not this app — so the host can verify a biometric check
 * by verifying a signature. Written against the platform rather than taken from a plugin:
 * it is the root of the credential, and `androidx.biometric` already arrives with
 * `local_auth`, so this costs no new dependency.
 */
class RefreshKeyChannel(private val activity: FragmentActivity) : MethodChannel.MethodCallHandler {
    companion object {
        const val CHANNEL = "lotus/refresh_key"
        private const val STORE = "AndroidKeyStore"
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val alias = call.argument<String>("alias")
            ?: return result.error("ARGUMENT", "alias is required", null)
        when (call.method) {
            "create" -> result.success(create(alias))
            "sign" -> sign(
                alias,
                call.argument<String>("payload") ?: "",
                call.argument<String>("title") ?: "Confirm it's you",
                result,
            )
            "delete" -> {
                runCatching { keyStore().deleteEntry(alias) }
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    /** Base64 SPKI of a new key, or null when this phone cannot hold one. */
    private fun create(alias: String): String? {
        // A key that demands authentication cannot exist without a lock to authenticate with.
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (keyguard == null || !keyguard.isDeviceSecure) return null
        runCatching { keyStore().deleteEntry(alias) }
        return try {
            generate(alias, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        } catch (e: ProviderException) {
            // `StrongBoxUnavailableException` is one of these; the TEE is the fallback.
            runCatching { generate(alias, strongBox = false) }.getOrNull()
        } catch (e: Exception) {
            null
        }
    }

    private fun generate(alias: String, strongBox: Boolean): String {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Every use authenticates (timeout 0), by strong biometric or the device
                    // credential — the same "passcode counts" rule `Biometrics` follows.
                    setUserAuthenticationParameters(
                        0,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                }
                if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    setIsStrongBoxBacked(true)
                }
            }
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
        generator.initialize(spec)
        return Base64.encodeToString(generator.generateKeyPair().public.encoded, Base64.NO_WRAP)
    }

    /**
     * Signs after the system prompt. Answers the signature, null for a cancel or a failed
     * prompt, or an error coded INVALIDATED / MISSING when the key can never sign again.
     */
    private fun sign(alias: String, payload: String, title: String, result: MethodChannel.Result) {
        val signature = try {
            val key = keyStore().getKey(alias, null) as? PrivateKey
                ?: return result.error("MISSING", "no key under $alias", null)
            Signature.getInstance("SHA256withECDSA").apply { initSign(key) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            runCatching { keyStore().deleteEntry(alias) }
            return result.error("INVALIDATED", "the key was invalidated by a biometric change", null)
        } catch (e: Exception) {
            return result.error("UNAVAILABLE", e.message, null)
        }

        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(auth: BiometricPrompt.AuthenticationResult) {
                    try {
                        val signer = auth.cryptoObject?.signature
                            ?: return result.error("UNAVAILABLE", "no signature after auth", null)
                        signer.update(payload.toByteArray(Charsets.UTF_8))
                        result.success(Base64.encodeToString(signer.sign(), Base64.NO_WRAP))
                    } catch (e: Exception) {
                        result.error("UNAVAILABLE", e.message, null)
                    }
                }

                // Cancel, lockout, no hardware: terminal, and not a lost key. A wrong finger
                // goes to onAuthenticationFailed, which keeps the prompt up — so no answer there.
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    result.success(null)
                }
            },
        )
        prompt.authenticate(promptInfo(title), BiometricPrompt.CryptoObject(signature))
    }

    private fun promptInfo(title: String): BiometricPrompt.PromptInfo {
        val builder = BiometricPrompt.PromptInfo.Builder().setTitle(title)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL).build()
        } else {
            // Before Android 11 a crypto-bound prompt cannot fall back to the device credential.
            builder.setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }
}
