package app.dash.network

import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLSocketFactory
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

internal object TlsTestFixture {
    private val heldCertificate = HeldCertificate.Builder()
        .commonName("localhost")
        .addSubjectAlternativeName("localhost")
        .build()

    val certificate: X509Certificate = heldCertificate.certificate

    val certificateSha256: String by lazy {
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    val differentCertificateSha256 = "0".repeat(64)

    val serverSocketFactory: SSLSocketFactory = HandshakeCertificates.Builder()
        .heldCertificate(heldCertificate)
        .build()
        .sslSocketFactory()
}
