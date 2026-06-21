package app.dash.connection

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionProfileTest {
    @Test fun buildsInsecureUrlsByDefault() {
        val p = ConnectionProfile("l", "1.2.3.4", mgmtToken = "m", chatToken = "tok")
        assertEquals("http://1.2.3.4:9300", p.mgmtBaseUrl)
        assertEquals("ws://1.2.3.4:9200/ws?token=tok", p.chatWsUrl)
    }

    @Test fun buildsSecureUrlsWhenSecure() {
        val p = ConnectionProfile("l", "host", mgmtToken = "m", chatToken = "t", secure = true)
        assertEquals("https://host:9300", p.mgmtBaseUrl)
        assertEquals("wss://host:9200/ws?token=t", p.chatWsUrl)
    }

    @Test fun urlEncodesChatTokenInQuery() {
        val p = ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "a b/c")
        assertEquals("ws://h:9200/ws?token=a+b%2Fc", p.chatWsUrl)
    }
}
