package app.dash.connection

import java.util.Locale

/** Canonical wire/storage format for a SHA-256 digest of an exact leaf certificate. */
object TlsCertificatePin {
    private val lowercaseHex = Regex("^[0-9a-f]{64}$")

    /** Returns canonical lowercase hex, or null when [value] is not exactly one SHA-256 digest. */
    fun normalize(value: String): String? {
        val normalized = value.trim().lowercase(Locale.US)
        return normalized.takeIf(lowercaseHex::matches)
    }

    fun isCanonical(value: String): Boolean = value == normalize(value)
}
