package app.dash.network

/** Thrown by [GatewayClient] when the gateway returns a non-2xx HTTP status. */
class GatewayHttpError(
    val status: Int,
    val bodyText: String,
) : RuntimeException("Gateway HTTP $status: $bodyText")
