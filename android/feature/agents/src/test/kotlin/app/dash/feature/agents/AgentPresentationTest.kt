package app.dash.feature.agents

import app.dash.model.AgentStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure decisions behind [AgentDetailScreen] (agent-detail refinement,
 * 2026-09-07). Mirrors iOS `AgentDetailPresentation` + `AgentToolCatalog` so an
 * agent reads the same on both phones.
 */
class AgentPresentationTest {
    @Test fun statusDisplayNamesMatchIos() {
        assertEquals("Ready", AgentStatus.REGISTERED.displayName())
        assertEquals("Active", AgentStatus.ACTIVE.displayName())
        assertEquals("Disabled", AgentStatus.DISABLED.displayName())
    }

    @Test fun chatIsOfferedOnlyForAgentsTheGatewayWillRun() {
        assertTrue(AgentPresentation.canStartChat(AgentStatus.REGISTERED))
        assertTrue(AgentPresentation.canStartChat(AgentStatus.ACTIVE))
        assertFalse(AgentPresentation.canStartChat(AgentStatus.DISABLED))
    }

    @Test fun toolLabelsAreFriendlyAndUnknownIdsAreHumanized() {
        assertEquals("Web Fetch", AgentToolCatalog.label("web_fetch"))
        assertEquals("List Directory", AgentToolCatalog.label("ls"))
        assertEquals("Add Connector", AgentToolCatalog.label("mcp_add_server"))
        assertEquals("Some New Tool", AgentToolCatalog.label("some_new_tool"))
    }

    @Test fun toolsGroupInWizardOrderWithUnknownsUnderOther() {
        val groups = AgentToolCatalog.groups(listOf("web_fetch", "grep", "read", "search", "bash"))
        assertEquals(listOf("Read & Search", "Shell", "Web", "Other"), groups.map { it.name })
        // Group order comes from the catalog, not the enabled list.
        assertEquals(listOf("read", "grep"), groups[0].tools)
        assertEquals("Browse and search the project", groups[0].description)
        assertEquals(listOf("search"), groups[3].tools)
        assertNull(groups[3].description)
    }

    @Test fun emptyToolListYieldsNoGroups() {
        assertTrue(AgentToolCatalog.groups(emptyList()).isEmpty())
    }
}
