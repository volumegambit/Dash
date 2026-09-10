package app.dash.network

/** Thrown by [GatewayClient] when the gateway returns a non-2xx HTTP status. */
open class GatewayHttpError(
    val status: Int,
    val bodyText: String,
) : RuntimeException("Gateway HTTP $status: $bodyText") {
    class Unauthorized(status: Int, bodyText: String) : GatewayHttpError(status, bodyText)

    class Structured(
        status: Int,
        bodyText: String,
        val error: app.dash.model.MobileApiError,
    ) : GatewayHttpError(status, bodyText)
}
