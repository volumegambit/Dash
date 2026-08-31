package app.dash.network

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

/** Builds an OkHttp client that trusts one exact TLS leaf certificate for one paired host. */
object PinnedTlsClientFactory {
    private const val SHA256_BYTES = 32
    private val lowercaseHex = Regex("^[0-9a-f]{64}$")

    fun create(
        baseClient: OkHttpClient,
        expectedHost: String,
        certificateSha256: String,
    ): OkHttpClient {
        val normalizedHost = normalizeHost(expectedHost)
        require(normalizedHost.isNotEmpty()) { "Pinned TLS host must not be blank" }
        val expectedDigest = decodeSha256(certificateSha256)
        val trustManager = ExactLeafTrustManager(expectedDigest)
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        }

        return baseClient.newBuilder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            // A self-signed LAN certificate need not carry the current IP/hostname.
            // Host binding comes from the trusted pairing profile plus the exact pin.
            .hostnameVerifier { requestedHost, _ -> normalizeHost(requestedHost) == normalizedHost }
            .build()
    }

    private fun decodeSha256(value: String): ByteArray {
        require(lowercaseHex.matches(value)) {
            "Certificate SHA-256 must be 64-character lowercase hex"
        }
        return ByteArray(SHA256_BYTES) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
    }

    private fun normalizeHost(value: String): String =
        value.trim().removePrefix("[").removeSuffix("]").trimEnd('.').lowercase(Locale.US)
}

private class ExactLeafTrustManager(
    private val expectedSha256: ByteArray,
) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not trusted")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull() ?: throw CertificateException("Server sent no certificate")
        leaf.checkValidity()
        val actualSha256 = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
        if (!MessageDigest.isEqual(expectedSha256, actualSha256)) {
            throw CertificateException("Server certificate does not match the paired gateway")
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
