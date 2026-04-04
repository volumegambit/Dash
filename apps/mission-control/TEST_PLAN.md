# Mission Control — Test Plan

Test plan for agent-driven QA. Each section is independently executable — it declares its required state and includes bootstrap steps to set it up from scratch.

**How to use this plan:**
1. Launch Mission Control in dev mode (`npm run mc:dev` from repo root)
2. Each section has a **Precondition** block. If the state isn't met, follow the **Bootstrap** steps to set it up.
3. Sections can be run individually (e.g., "Run Section 8" to test file tool use) or sequentially (running Sections 1-4 in order naturally builds up the state later sections need).
4. At each "Verify" step, take a screenshot and judge against the criteria.
5. Log any failure with: section number, what was expected, what was observed, screenshot.

**Test credentials:** Copy `test-credentials.example.json` to `test-credentials.json` and fill in real API keys before running.

**Clean start:** To test from a fresh state, use a temp data directory:
```bash
MC_DATA_DIR=/tmp/mc-test-$(date +%s) npm run mc:dev
```

---

## Section 1: Fresh App Launch & Setup Wizard

**Precondition:** Clean data directory (no prior setup). Start MC with `MC_DATA_DIR=/tmp/mc-test-$(date +%s) npm run mc:dev`

### 1.1 Gateway Initialization
1. Launch the app
2. **Verify:** A setup wizard screen is visible (not the dashboard)
3. **Verify:** A loading spinner or "Setting up" message is shown while the gateway initializes
4. Wait for initialization to complete (or fail)

### 1.2 Provider Selection
1. After gateway init, a provider selection screen should appear
2. **Verify:** Three provider cards visible: Anthropic, OpenAI, Google
3. Click the Anthropic card
4. **Verify:** The Anthropic card has a selected/highlighted visual state; the others do not
5. Click the OpenAI card
6. **Verify:** Only OpenAI is highlighted now (Anthropic is deselected)
7. Click back to Anthropic, then click "Next"

### 1.3 API Key Entry
1. **Verify:** The screen shows Anthropic-specific title and explanation
2. **Verify:** Numbered how-to steps are displayed (1, 2, 3...) with colored step circles
3. **Verify:** There is a "Key name" input and an "API key" input
4. **Verify:** The API key input is a password field (characters masked)
5. **Verify:** The save/submit button is disabled (both fields empty)
6. Type `my key!` in the key name field
7. Type anything in the API key field
8. Click save
9. **Verify:** An error message appears about invalid key name characters (only alphanumeric and hyphens allowed)
10. Clear the key name, type `default`
11. Type `sk-ant-test-fake-key-12345` in the API key field
12. **Verify:** The save button is now enabled
13. Click save
14. **Verify:** The wizard advances to a "Done" / welcome screen

### 1.4 Setup Complete
1. **Verify:** The dashboard loads after the wizard completes
2. **Verify:** The sidebar is visible with navigation links

---

## Section 2: Sidebar & Navigation

**Precondition:** App is running past setup.

> Note: The sidebar is visible on every page and is tested implicitly throughout the plan. This section covers the sidebar-specific checks only.

### 2.1 Sidebar Layout & Health
1. Take a screenshot of the full sidebar
2. **Verify:** Logo at top with a small green health dot (gateway healthy)
3. **Verify:** Three nav sections: CORE (Dashboard, Chat), MANAGE (Agents, Messaging Apps), CONFIGURE (AI Providers, Connectors, Web Search, Settings)
4. **Verify:** Feedback link at bottom
5. Click "Agents" in sidebar
6. **Verify:** "Agents" is highlighted (bold, left accent border); other links are not

---

## Section 3: AI Providers (Connections)

**Precondition:** App running, at least one API key configured.
**Bootstrap:** If no key exists, go to AI Providers → click "Add Key" for Anthropic → enter key name `default` and a valid API key from `test-credentials.json` → Save.

### 3.1 Page Layout
1. Navigate to AI Providers
2. Take a screenshot of the full page
3. **Verify:** Provider sections visible (Anthropic, OpenAI, Google)
4. **Verify:** The key added during setup (`default`) appears under Anthropic
5. **Verify:** An "Add Key" or "+" button is visible for each provider
6. **Verify:** Buttons use bordered style (not plain text links)

### 3.2 Add a Second Key
1. Click the "Add Key" button for Anthropic
2. **Verify:** A modal opens with provider-specific instructions
3. **Verify:** Modal has: key name input, API key input (password field), numbered how-to steps, external links, Cancel and Save buttons
4. **Verify:** Save is disabled when fields are empty
5. Type `secondary` in key name
6. Type `sk-ant-test-secondary-key` in API key
7. Click Save
8. **Verify:** Modal closes; `secondary` key now appears in the Anthropic section

### 3.3 Key Deletion (No Agents Affected)
1. Click the remove/trash button next to the `secondary` key
2. **Verify:** A confirmation dialog appears
3. Click confirm/remove
4. **Verify:** The `secondary` key disappears from the list

### 3.4 Escape Key Closes Modals
1. Click "Add Key" for any provider to open the modal
2. Press Escape
3. **Verify:** The modal closes
4. **Verify:** No key was added

---

## Section 4: Create an Agent

**Precondition:** At least one API key exists.
**Bootstrap:** If no key, follow Section 3 bootstrap. Then navigate to Agents page.

### 4.1 Start Create Agent Wizard
1. Navigate to Agents page
2. **Verify:** Empty state is shown ("No agents" message with a create agent prompt)
3. Click "Create Agent" button
4. **Verify:** Create Agent wizard opens with Step 1 (agent configuration)

### 4.2 Configure Agent
1. **Verify:** Agent name input is present and empty
2. **Verify:** Model selector shows available models
3. **Verify:** Models without credentials are grayed out or marked "key missing"
4. Type `test-agent` in the name field
5. Select a model that has a credential (should be available from setup)
6. Optionally type a system prompt: `You are a helpful test assistant.`
7. **Verify:** Tool selector shows groups (Read & Search, Modify Files, Shell, etc.)
8. Toggle a few tools on
9. Click "Next" to advance to review

### 4.3 Review & Create
1. **Verify:** Review screen shows all configured values (name, model, prompt, tools)
2. Click "Create"
3. **Verify:** A loading state appears during creation
4. **Verify:** After creation, you are navigated to the agent detail page
5. **Verify:** The agent shows as "running" with a green status dot

---

## Section 5: Agent Detail Page

**Precondition:** A running agent exists.
**Bootstrap:** If no agent, follow Section 4 to create `test-agent`. Then click on it in the Agents list.

### 5.1 Overview Tab
1. Navigate to the agent detail page (click on `test-agent` in agents list)
2. **Verify:** Header shows agent name, status dot (green), Chat/Disable/Remove buttons
3. **Verify:** Overview tab shows: status, model name, system prompt, tools list

### 5.2 Inline Rename
1. Click the pencil icon next to the agent name
2. **Verify:** Name becomes an editable text field
3. Change the name to `renamed-agent`
4. Press Enter
5. **Verify:** The name updates to `renamed-agent`
6. Click pencil again, change name, press Escape
7. **Verify:** The edit is cancelled; name reverts to `renamed-agent`

### 5.3 Configuration Tab
1. Click the "Configuration" tab
2. **Verify:** Collapsible cards: Models, System Prompt, Tools, Connectors
3. Click the Models card to expand it
4. **Verify:** Primary model dropdown and fallback chain editor visible
5. **Verify:** Save and Cancel buttons appear
6. Click Cancel to collapse
7. Expand the System Prompt card
8. **Verify:** Textarea with current prompt, editable
9. Collapse without saving

### 5.4 Chat Button
1. Click the "Chat" button in the agent header
2. **Verify:** Navigates to `/chat` with this agent pre-selected

---

## Section 6: Chat — Conversations & Input

**Precondition:** A running agent with all tools enabled.
**Bootstrap:** If no agent, go to Agents → Create Agent → name `chat-test-agent`, select a model, enable all tool groups (Read & Search, Modify Files, Shell, Web, Skills), set system prompt to `You are a helpful assistant. Use tools when asked.` → Create. Then navigate to Chat.

### 6.1 Select Agent & Create Conversation
1. Navigate to Chat page
2. **Verify:** A agent selector is visible (dropdown or list)
3. Select the agent from the selector
4. **Verify:** The agent is now the active agent (conversations for this agent load)
5. Click "New Conversation" (or the + button)
6. **Verify:** A new conversation appears in the list and is selected
7. **Verify:** The message input area is focused and ready for typing

### 6.2 Send a Simple Message
1. Type `Hello, what can you do?` in the input
2. **Verify:** Send button is enabled
3. Press Enter (or click Send)
4. **Verify:** Your message appears immediately on the right side (optimistic UI) with dark background and left accent border
5. **Verify:** A streaming indicator or spinner appears while assistant responds
6. **Verify:** Text streams in progressively (not all at once)
7. Wait for completion
8. **Verify:** Assistant response appears left-aligned in a bordered bubble
9. **Verify:** Token usage shown below the response (e.g., "1.2k in · 0.4k out")
10. **Verify:** Send button is re-enabled

### 6.3 Multi-line Input
1. Click into the input field
2. Press Shift+Enter
3. **Verify:** A newline is inserted (message is NOT sent)
4. Type text on the second line
5. Press Enter (without Shift)
6. **Verify:** The multi-line message is sent as one message

### 6.4 Cancel Streaming
1. Send: `Write a very long detailed essay about the history of software testing, at least 2000 words`
2. While the response is streaming, click the Stop/Cancel button
3. **Verify:** Streaming stops; the partial response text is preserved and readable
4. **Verify:** The input is re-enabled for the next message
5. **Verify:** No error is shown (cancellation is not an error)

### 6.5 Conversation List Management
1. Hover over the conversation in the sidebar list
2. Click the rename (pencil) icon
3. Type `Test Chat` and press Enter
4. **Verify:** The conversation title updates to "Test Chat" in the list
5. Create a second conversation, send a message in it
6. Switch back to "Test Chat"
7. **Verify:** Messages from "Test Chat" are loaded (not the other conversation's messages)
8. Click the delete (trash) icon on the second conversation
9. **Verify:** A confirmation appears
10. Confirm deletion
11. **Verify:** The conversation is removed; "Test Chat" remains and is selected

### 6.6 Conversation Search
1. Create 3+ conversations with different names
2. Type part of a conversation name in the search field
3. **Verify:** List filters to matching conversations only
4. Clear the search
5. **Verify:** Full list restored

### 6.7 Unread Indicators
1. Have two conversations open
2. Select conversation A
3. In conversation B, wait for or trigger a new assistant message (by sending from another session or switching quickly)
4. **Verify:** Conversation B shows an unread indicator/badge while A is selected
5. Click on conversation B
6. **Verify:** Unread indicator clears

---

## Section 7: Chat — Text & Markdown Rendering

**Precondition:** Active conversation with a running agent.
**Bootstrap:** Follow Section 6 bootstrap, then select the agent in Chat and create a new conversation.

### 7.1 Plain Text Response
1. Send: `Say hello in one sentence`
2. **Verify:** Response is plain text, readable, left-aligned
3. **Verify:** Text uses standard body font (not monospace)

### 7.2 Markdown Formatting
1. Send: `Show me examples of markdown formatting: headings, bold, italic, lists, blockquotes, and a table`
2. **Verify:** Headings render at different sizes (H1 > H2 > H3)
3. **Verify:** **Bold** and *italic* text render correctly
4. **Verify:** Bullet lists have proper indentation with list markers
5. **Verify:** Numbered lists have sequential numbers
6. **Verify:** Blockquotes have a left border and muted styling
7. **Verify:** Tables render with bordered cells, headers distinct from body

### 7.3 Inline Code
1. Send: `Explain the difference between let and const in JavaScript, use inline code for the keywords`
2. **Verify:** Inline code spans (e.g., `let`, `const`) have distinct background color and monospace font
3. **Verify:** Inline code is visually distinct from surrounding text

### 7.4 Code Blocks with Syntax Highlighting
1. Send: `Write a Python function that calculates fibonacci numbers`
2. **Verify:** Code appears in a dark-background code block
3. **Verify:** Python keywords (def, return, if) are syntax-highlighted in different colors
4. **Verify:** A copy button is visible on the code block
5. Click the copy button
6. **Verify:** Visual feedback (checkmark or "Copied") confirms the copy

### 7.5 Multiple Code Blocks with Different Languages
1. Send: `Show me the same hello world program in Python, JavaScript, and Rust as separate code blocks`
2. **Verify:** Three separate code blocks appear
3. **Verify:** Each has syntax highlighting appropriate to its language
4. **Verify:** Each has its own copy button

### 7.6 Links in Responses
1. Send: `What is the official website for Node.js? Include the link.`
2. **Verify:** URLs render as clickable links (accent color, underline on hover)
3. Click a link
4. **Verify:** Opens in system browser (not inside the app)

---

## Section 8: Chat — Tool Use: File Operations

**Precondition:** Agent with Read & Search, Modify Files, and Shell tools enabled. Agent has a workspace directory.
**Bootstrap:** Follow Section 6 bootstrap (creates agent with all tools). Create a new conversation with that agent.

### 8.1 Read Tool — File Content Display
1. Send: `Read the file package.json in your workspace`
2. **Verify:** A tool block appears with label "Read" and the file path
3. **Verify:** The tool block is expandable/collapsible (click header to toggle)
4. **Verify:** File content is displayed with syntax highlighting (JSON)
5. **Verify:** Line numbers are visible alongside the content
6. **Verify:** The content is scrollable if it exceeds the visible area

### 8.2 Read Tool — Various File Types
1. Send: `Read the tsconfig.json file` (JSON file)
2. **Verify:** JSON syntax highlighting (keys, values, brackets in different colors)
3. If a TypeScript file is available, send: `Read src/index.ts`
4. **Verify:** TypeScript syntax highlighting (keywords, types, strings)

### 8.3 Write Tool — Code File
1. Send: `Create a file called test-output.ts in the workspace with a simple hello world function`
2. **Verify:** A tool block appears with label "Write" and the file path
3. **Verify:** The written content is previewed with syntax highlighting
4. **Verify:** The tool result shows success (green indicator, not red)

### 8.4 Write Tool — Markdown File
1. Send: `Create a file called README.md with a title, description, and a code example`
2. **Verify:** A tool block appears labeled "Write"
3. **Verify:** The markdown content is rendered as formatted markdown (not raw text) — headings, paragraphs, code blocks

### 8.5 Write Tool — JSON File
1. Send: `Create a file called config.json with some sample configuration`
2. **Verify:** JSON content is pretty-printed with syntax highlighting

### 8.6 Edit Tool — Diff View
1. First create a file: `Create a file called greet.ts with a function greet(name) that returns "Hello, " + name`
2. Then: `Edit greet.ts to add a second parameter 'greeting' with a default value of "Hello"`
3. **Verify:** A tool block appears labeled "Edit" with the file path
4. **Verify:** A **diff view** is shown with:
   - Removed lines in red/pink background with `-` prefix
   - Added lines in green background with `+` prefix
   - Context lines with no background
   - Line numbers in a gutter column
5. **Verify:** The diff is syntax-highlighted (TypeScript keywords colored)
6. **Verify:** The diff view is expanded by default (not collapsed)

### 8.7 Glob/Find Tool — File Search
1. Send: `Find all TypeScript files in the workspace`
2. **Verify:** A tool block appears labeled "Find" with the search pattern
3. **Verify:** Results show file paths

### 8.8 Grep Tool — Content Search
1. Send: `Search for the word "export" in all .ts files`
2. **Verify:** A tool block appears labeled "Grep" with the search pattern
3. **Verify:** Results show matching lines with file paths

### 8.9 List Directory Tool
1. Send: `List the files in the workspace root directory`
2. **Verify:** A tool block appears labeled "List Directory"
3. **Verify:** Directory listing shows entries with folder/file icons:
   - Folders: folder icon + accent-colored text
   - Files: file icon + regular-colored text

---

## Section 9: Chat — Tool Use: Shell & Web

### 9.1 Bash Tool — Command Execution
1. Send: `Run the command "echo hello world" in the shell`
2. **Verify:** A tool block appears labeled "Bash"
3. **Verify:** The command is shown in the header/summary with syntax highlighting
4. **Verify:** The output "hello world" is displayed in the tool result
5. **Verify:** Short output (1-3 lines) is shown inline in green-tinted text

### 9.2 Bash Tool — Long Output
1. Send: `Run "ls -la /usr" in the shell`
2. **Verify:** Output is displayed in a scrollable code block (not inline)
3. **Verify:** Output has syntax highlighting or monospace formatting

### 9.3 Bash Tool — Error Output
1. Send: `Run the command "cat /nonexistent/file" in the shell`
2. **Verify:** Tool result shows error output
3. **Verify:** The tool block has an error indicator (red icon or red-tinted background)

### 9.4 Web Search Tool
1. Send: `Search the web for "latest Node.js version"`
2. **Verify:** A tool block appears labeled "Web Search" with the query
3. **Verify:** Search results are displayed in the result area
4. (This requires the Brave API key from Section 10 — skip if not configured)

### 9.5 Web Fetch Tool
1. Send: `Fetch the contents of https://example.com`
2. **Verify:** A tool block appears labeled "Web Fetch" with the URL
3. **Verify:** The fetched HTML/text content is displayed

---

## Section 10: Chat — Tool Use: Tasks & Skills

### 10.1 TodoWrite / Task Tool
1. Send: `Create a task list with 3 items: "Design API", "Implement endpoints", "Write tests"`
2. **Verify:** A tool block appears with a todo/task list display
3. **Verify:** Each item shows a status indicator:
   - `○` for pending items
   - `◉` for in-progress items (if any)
   - `✓` for completed items (if any)
4. **Verify:** A completion counter is shown (e.g., "0/3 done")
5. **Verify:** Completed items have line-through text styling

### 10.2 Pinned Todo Panel
1. After tasks are created, look at the bottom of the chat area (above the input)
2. **Verify:** A pinned todo panel appears showing task progress
3. **Verify:** The panel has an expand/collapse toggle (chevron)
4. **Verify:** Collapsed state shows the active in-progress task (if any)
5. **Verify:** Expanded state shows the full task list with progress bar

### 10.3 Skill Created Event
1. If the agent creates a skill during interaction:
2. **Verify:** A notification appears indicating the skill was created
3. (This may be hard to trigger deliberately — note if the event type renders or is silent)

---

## Section 11: Chat — Thinking Blocks

### 11.1 Extended Thinking Display
1. Send a complex request that triggers thinking: `Think step by step about how to design a REST API for a todo app. Consider authentication, pagination, and error handling.`
2. **Verify:** If the model supports extended thinking, a "Thinking" block appears
3. **Verify:** The thinking block is collapsible with a "Show/Hide thinking" toggle
4. **Verify:** Default state is collapsed
5. Click to expand
6. **Verify:** Thinking text is shown in monospace/preformatted font
7. **Verify:** Thinking block has a border and distinct background from the main response
8. Click to collapse
9. **Verify:** Thinking text is hidden, only the toggle remains

---

## Section 12: Chat — Questions & Interactive Elements

### 23.1 Agent Question with Options
1. If the agent asks a multiple-choice question during interaction:
2. **Verify:** The question text is displayed with a ❓ prefix
3. **Verify:** Options appear as clickable buttons
4. **Verify:** The question block has an accent border and tinted background
5. Click one of the option buttons
6. **Verify:** The answer is sent
7. **Verify:** The question switches to "answered" state: shows checkmark + selected answer in green

### 23.2 Agent Question without Options
1. If the agent asks an open-ended question:
2. **Verify:** A text input field appears with a "Reply" button
3. Type an answer and click Reply
4. **Verify:** The answer is sent and the question shows as answered

---

## Section 13: Chat — Image Handling

### 13.1 Attach Images to Message
1. Click the attachment/paperclip icon in the chat input area
2. Select a JPEG image from the file picker
3. **Verify:** A thumbnail preview appears in the input area
4. **Verify:** The thumbnail has an X button to remove it
5. Add a second image (up to 4)
6. **Verify:** Multiple thumbnails shown in a row

### 13.2 Send Message with Images
1. With images attached, type a message: `What do you see in these images?`
2. Click Send
3. **Verify:** Your message appears with thumbnail images displayed
4. **Verify:** Images are shown as small previews (max height ~48px)
5. **Verify:** The assistant responds referencing the image content

### 13.3 Image Validation
1. Try to attach a file that is not an image (e.g., a .txt file)
2. **Verify:** An error message about unsupported file type
3. Try to attach more than 4 images
4. **Verify:** An error message about maximum image count
5. Try to attach an image larger than 5MB
6. **Verify:** An error message about file size

### 13.4 Remove Attached Image
1. Attach an image
2. Click the X button on the thumbnail
3. **Verify:** The image is removed from the attachment area
4. **Verify:** The message can still be sent (text only)

### 13.5 Images in Assistant Responses
1. If the assistant generates or references an image in markdown:
2. **Verify:** The image renders inline in the response
3. **Verify:** A download button appears on hover over the image

---

## Section 14: Chat — Error Handling

### 14.1 Generic Error
1. Trigger an error (e.g., send a message to an agent that has been stopped mid-conversation)
2. **Verify:** An error block appears in red text
3. **Verify:** If the error has a timestamp, a "View logs →" link is shown
4. Click "View logs →" if present
5. **Verify:** Navigates to the agent's log view at the relevant timestamp

### 14.2 Authentication Error
1. Remove the API key for the agent's provider while a conversation is active
2. Send a message
3. **Verify:** An error appears containing auth-related text (401, 403, "unauthorized", "authentication", or "invalid key")
4. **Verify:** An "Update Key →" button/link appears in the error
5. Click "Update Key →"
6. **Verify:** Navigates to the AI Providers (Connections) page

### 14.3 MCP Tool Error
1. If agent uses an MCP tool and the connector is down:
2. **Verify:** The tool result shows an error state (red icon, error text)
3. **Verify:** The error does not crash the entire chat — subsequent messages can still be sent

---

## Section 15: Chat — Credential & MCP Banners

**Bootstrap:** For 15.1: Create an agent (Section 4), then remove its API key from AI Providers. For 15.2-15.3: Create an agent that uses an MCP connector (assign via Agent Detail → Configuration → Connectors card).

### 15.1 Missing Credential Banner
1. Create an agent, then remove its API key
2. Navigate to Chat, select a conversation for that agent
3. **Verify:** Yellow banner above input: "This agent is missing an API key for [provider]"
4. **Verify:** Chat input is disabled (cannot type or send)
5. **Verify:** Send button is disabled (50% opacity)
6. Add the key back
7. **Verify:** Banner disappears, input re-enabled

### 15.2 MCP Connector Offline Banner
1. Create an agent that uses an MCP connector
2. Simulate connector going offline (remove/stop the MCP server)
3. Navigate to Chat for that agent
4. **Verify:** Yellow banner: "[connector-name] connector is offline"
5. **Verify:** A "Reconnect" button is shown in the banner
6. **Verify:** Chat input is still enabled (MCP issues don't block chat)
7. Click "Reconnect"
8. **Verify:** The reconnect action is triggered (banner may update)

### 15.3 MCP Connector Needs Re-auth Banner
1. If a connector enters `needs_reauth` state:
2. **Verify:** Yellow banner: "[connector-name] connector needs re-authorization"
3. **Verify:** A "Re-authorize" button is shown (not "Reconnect")
4. **Verify:** Chat input is still enabled
5. Click "Re-authorize"
6. **Verify:** OAuth re-auth flow is triggered

### 15.4 Banner Priority
1. If agent has BOTH a missing credential AND an MCP issue:
2. **Verify:** Only the credential banner is shown (not both)
3. **Verify:** After fixing the credential, the MCP banner appears if the issue persists

---

## Section 16: Chat — Tool Block UI Details

### 16.1 Tool Block Expand/Collapse
1. Trigger any tool use (e.g., Read a file)
2. **Verify:** Tool block has a clickable header with tool icon, label, and summary
3. Click the header to collapse
4. **Verify:** Tool content hides, only header visible
5. Click again to expand
6. **Verify:** Tool content reappears

### 16.2 Tool Block Success vs Error States
1. Trigger a successful tool call (e.g., read an existing file)
2. **Verify:** Tool block header has a green/filled circle indicator
3. Trigger a failed tool call (e.g., read a nonexistent file)
4. **Verify:** Tool block header has a red XCircle error indicator
5. **Verify:** Error tool block has a reddish background tint (red-900/10)

### 16.3 Tool Input Details
1. Expand a tool block
2. **Verify:** Input parameters are shown as key-value pairs below the result
3. For Read tool: path is shown but offset/limit are hidden
4. For Write tool: content is shown as a rendered preview (not in the details section)
5. For Bash tool: command shown in the summary header with syntax highlighting

### 16.4 In-Progress Tool Indicator
1. While a tool is executing (between tool_use_start and tool_result):
2. **Verify:** The tool block shows a loading/spinner indicator
3. **Verify:** The tool label is visible even before the result arrives
4. After the result arrives:
5. **Verify:** The spinner is replaced by the success/error indicator

### 16.5 Multiple Sequential Tool Calls
1. Send a request that triggers multiple tools: `Read package.json, then list the files in the src directory, then show me the content of src/index.ts`
2. **Verify:** Multiple tool blocks appear in sequence
3. **Verify:** Each tool block is independently expandable/collapsible
4. **Verify:** Tool blocks appear in the order they were executed
5. **Verify:** A text response follows after all tool results

### 16.6 SVG Write Preview
1. Send: `Create a simple SVG file called icon.svg with a circle`
2. **Verify:** Write tool block shows the SVG rendered as an image (not raw XML)
3. **Verify:** No script tags or event handlers execute (sanitized)

---

## Section 17: Chat — Copy & Selection

### 17.1 Copy Message Text
1. Hover over an assistant message
2. **Verify:** A copy button appears
3. Click it
4. **Verify:** Message text is copied to clipboard (paste somewhere to confirm)

### 17.2 Copy Code Block
1. Find a code block in a response
2. **Verify:** A copy button is visible on the code block (top-right area)
3. Click it
4. **Verify:** Visual feedback (icon changes to checkmark, or "Copied" text)

### 17.3 Copy User Message
1. Hover over your own (user) message
2. **Verify:** A copy button appears
3. Click it
4. **Verify:** Your message text is copied

---

## Section 18: Agents List

**Precondition:** At least one agent created

### 7.1 List View
1. Navigate to Agents page
2. Take a screenshot
3. **Verify:** Table shows: status dot, agent name, model, tools count, registration time
4. **Verify:** Status dot is green for the running agent
5. **Verify:** Relative timestamps displayed (e.g., "5m ago")

### 7.2 Search
1. Type part of the agent name in the search bar
2. **Verify:** List filters to matching agents
3. Clear the search
4. **Verify:** Full list restored

### 7.3 Agent Removal
1. Click the trash/remove icon on the agent row (or navigate to detail → Remove)
2. **Verify:** A confirmation modal appears with the agent name
3. **Verify:** Optional "Delete workspace" checkbox is present
4. Click Cancel
5. **Verify:** Modal closes, agent still in list

---

## Section 19: Connectors (MCP)

**Precondition:** App running

### 19.1 Empty State
1. Navigate to Connectors page
2. **Verify:** Empty state message with connector icon
3. **Verify:** "Add Connector" button is visible in the header

### 19.2 Add Connector Modal
1. Click "Add Connector"
2. **Verify:** Modal opens with: Name input, Transport type selector, URL/command inputs
3. **Verify:** Transport types available: Standard (HTTP), SSE, Command (stdio)
4. Select "Command (stdio)"
5. **Verify:** Input changes to Command + Arguments fields (URL field disappears)
6. Select "Standard (HTTP)"
7. **Verify:** URL field reappears
8. **Verify:** "Connect" button is disabled until name and URL are filled
9. Type `test-mcp` in name, `http://localhost:9999` in URL
10. Click Connect
11. **Verify:** Either connects (shows in list) or shows error (server not running is expected)
12. Click Cancel or close the modal

### 19.3 Environment Variables
1. Open Add Connector modal
2. Click "+ Add variable"
3. **Verify:** A key-value pair row appears
4. Add another
5. **Verify:** Multiple rows shown
6. Click the X to remove one
7. **Verify:** Row removed

### 19.4 URL Allowlist
1. Scroll to the bottom of the Connectors page
2. Click "URL Allowlist" to expand
3. **Verify:** Empty message: "No URL restrictions configured. All connector URLs are allowed."
4. Type `https://*.example.com` in the input
5. Click "Add" (or press Enter)
6. **Verify:** Pattern appears in the list
7. Click the X next to the pattern
8. **Verify:** Pattern removed

---

## Section 20: Messaging Apps — Telegram End-to-End

**Precondition:** At least one running agent. Test credentials with a valid Telegram bot token.
**Bootstrap:** If no agent, follow Section 4. Load bot token, username, and test user ID from `test-credentials.json`.

### 20.1 Empty State
1. Navigate to Messaging Apps
2. **Verify:** Empty state with "Add Telegram" and "Connect WhatsApp" options

### 20.2 Telegram Wizard — Invalid Token
1. Click "Add Telegram"
2. **Verify:** Wizard shows path options (New Bot / Know BotFather / Have Token)
3. Select "I have a token" (or equivalent)
4. **Verify:** Token input field appears
5. Type an invalid token like `fake-token-12345`
6. Click verify/next
7. **Verify:** Error message shown (verification fails)
8. **Verify:** Wizard does not advance to the naming step

### 20.3 Telegram Wizard — Valid Token
1. Paste the real bot token from `test-credentials.json`
2. Click verify/next
3. **Verify:** Verification succeeds — bot username and first name are displayed
4. **Verify:** Wizard advances to the connection naming step
5. **Verify:** Connection name auto-suggested (e.g., "{botFirstName}'s Bot")

### 20.4 Telegram Wizard — Configure & Create
1. Accept or change the connection name
2. Select the agent as the target
3. Choose "Open access" (allow all users) OR "Whitelist" mode
4. If whitelist: enter the test user ID from `test-credentials.json`
5. Click submit/create
6. **Verify:** Channel is created; navigates to messaging app detail or back to list
7. **Verify:** The new Telegram channel appears in the Messaging Apps list with "Connected" badge

### 20.5 Telegram Channel Detail
1. Click on the newly created Telegram channel
2. **Verify:** Detail page shows: platform icon (Telegram), connection name, "Connected" badge
3. **Verify:** Routing rules section shows the configured rule (default or sender-filtered)
4. **Verify:** Target agent name is displayed in the routing rule
5. **Verify:** Delete button is visible in the header

### 20.6 Telegram — Send Message via Web
1. Open a browser and navigate to `https://web.telegram.org`
2. Log in with the Telegram account that owns the test user ID
3. Search for the test bot by its username (from `test-credentials.json`)
4. Open the chat with the bot
5. Send a message: `Hello from test`
6. **Verify:** The message is sent successfully in Telegram Web

### 20.7 Telegram — Verify Message Received in MC
1. Switch back to Mission Control
2. Navigate to Messaging Apps → click the Telegram channel
3. Check the message log (if available) for the received message
4. **Verify:** The message "Hello from test" appears in the log with the sender ID
5. **Verify:** The log shows which agent handled the message

### 20.8 Telegram — Verify Agent Response in Chat
1. Navigate to Chat in Mission Control
2. Look for a conversation created by the Telegram message
3. **Verify:** The user message from Telegram appears in the conversation
4. **Verify:** The agent's response is visible (the agent processed the message)

### 20.9 Telegram — Verify Bot Reply in Telegram Web
1. Switch back to Telegram Web
2. Check the chat with the test bot
3. **Verify:** The bot has replied with the agent's response
4. **Verify:** The response text matches what was shown in the MC Chat view

### 20.10 Telegram — Send Multiple Messages
1. In Telegram Web, send 3 messages rapidly: `Message 1`, `Message 2`, `Message 3`
2. Switch to Mission Control Chat
3. **Verify:** All 3 messages were received and processed
4. **Verify:** Each message has a corresponding agent response
5. **Verify:** Messages are in the correct order

### 20.11 Telegram — Whitelist Enforcement
1. If the channel was configured with whitelist mode:
2. In MC, navigate to the channel detail and check the routing rule has sender condition
3. Send a message from the whitelisted user ID — should be received
4. (If possible) have a non-whitelisted user message the bot
5. **Verify:** Non-whitelisted messages are blocked (no conversation created in MC)

### 20.12 Telegram — Update Routing
1. Navigate to the Telegram channel detail page
2. Add a new routing rule or modify the existing one
3. **Verify:** Changes save successfully
4. Send another message from Telegram Web
5. **Verify:** The message routes according to the updated rules

### 20.13 Telegram — Delete Channel
1. Navigate to the Telegram channel detail page
2. Click the Delete button
3. **Verify:** Confirmation modal appears
4. Confirm deletion
5. **Verify:** Channel is removed from the Messaging Apps list
6. Send a message to the bot from Telegram Web
7. **Verify:** The bot no longer responds (channel is disconnected)

### 20.14 Messaging App Log
1. Before deleting the channel (or create a new one): navigate to the channel detail
2. Look for a message log or history section
3. **Verify:** Log shows: timestamp, sender ID, sender name, message text, outcome (routed/blocked), agent name
4. **Verify:** Log entries match the messages sent from Telegram Web

---

## Section 20B: Messaging Apps — WhatsApp

### 20B.1 WhatsApp Wizard — QR Display
1. Navigate to Messaging Apps, click "Connect WhatsApp"
2. **Verify:** Intro screen explains Linked Devices feature
3. Click Next/Continue
4. **Verify:** QR code area is shown (may show loading then actual QR)
5. **Verify:** Instructions for scanning are displayed
6. **Verify:** QR code refreshes or shows retry option if it expires

---

## Section 21: Web Search

### 21.1 No Key Set
1. Navigate to Web Search
2. **Verify:** Password input field and "Save" button visible
3. **Verify:** Link to Brave Search API signup is present

### 21.2 Save and Display Key
1. Type `BSA-test-fake-key-123456789012` in the input
2. Click Save
3. **Verify:** Input is replaced by masked display (first 6 + last 4 chars visible)
4. **Verify:** "Remove" button is present

### 21.3 Remove Key
1. Click Remove
2. **Verify:** Returns to empty state with input field

---

## Section 22: Settings

### 22.1 Default Model Chain
1. Navigate to Settings
2. **Verify:** "Default Model Chain" section with model selector
3. **Verify:** "Refresh Models" button is present
4. Select a model
5. **Verify:** Selection is saved

### 22.2 Gateway Restart
1. On the Settings page, locate the "Gateway" section
2. **Verify:** "Restart Gateway" button is visible with a refresh icon
3. Note the current sidebar health dot color (should be green)
4. Click "Restart Gateway"
5. **Verify:** Button changes to "Restarting..." with a spinning icon
6. **Verify:** Button is disabled during restart (cannot click again)
7. **Verify:** Sidebar health dot changes from green to yellow or red briefly
8. Wait for restart to complete
9. **Verify:** Button returns to "Restart Gateway" (no longer spinning)
10. **Verify:** Sidebar health dot returns to green
11. Navigate to Agents page
12. **Verify:** Agents are still listed and running (state survived the restart)
13. Navigate to Chat, select an existing conversation
14. **Verify:** Previous messages are still loaded (conversations survived the restart)
15. Send a new message
16. **Verify:** The agent responds successfully (gateway is fully operational)

### 22.3 Gateway Restart — Connector Recovery
1. If MCP connectors are configured:
2. Navigate to Connectors page, note connector statuses (should be green)
3. Go to Settings, click "Restart Gateway"
4. Wait for restart to complete
5. Navigate to Connectors page
6. **Verify:** Connectors reconnect automatically (may briefly show reconnecting, then connected)

### 22.4 About Section
1. **Verify:** App version number is displayed (e.g., "DashSquad v0.x.x")

---

## Section 23: UI Consistency Audit

Take screenshots of every page and evaluate against these criteria. This section tests visual polish, not functionality.

### 23.1 Button Styles
1. Visit every page and take note of all buttons
2. **Verify:** Primary action buttons (Create, Save, Connect) use accent background + white text
3. **Verify:** Secondary buttons (Cancel, Back) use bordered style with transparent background
4. **Verify:** Danger buttons (Remove, Delete) use red text or red border
5. **Verify:** Disabled buttons show 50% opacity
6. **Verify:** All "Add Key" / "Add Connector" style buttons use bordered style (not plain text)
7. **Verify:** Icon-only buttons (trash, refresh, pencil) use consistent padding

### 23.2 Form Inputs
1. Check text inputs across: Setup Wizard, Create Agent Wizard, Add Key modal, Add Connector modal, Web Search
2. **Verify:** All text inputs have consistent border color, background, and focus style (border-accent on focus)
3. **Verify:** All password inputs use monospace font
4. **Verify:** All dropdowns match text input styling
5. **Verify:** Labels are positioned above inputs with consistent size and muted color
6. **Verify:** Placeholder text uses muted color
7. **Verify:** Error messages appear in red below the relevant input

### 23.3 Status Dots
1. Check status dots on: Sidebar (gateway), Agents list, Connectors page, Agent detail (channels tab)
2. **Verify:** Green = healthy/connected/running — same shade everywhere
3. **Verify:** Yellow = warning/starting — same shade everywhere
4. **Verify:** Red = error/disconnected — same shade everywhere
5. **Verify:** Pulsing animation only on connecting/reconnecting states
6. **Verify:** Dots are consistently sized within each context

### 23.4 Page Headers
1. Visit every main page (Dashboard, Chat, Agents, Create Agent, AI Providers, Connectors, Messaging Apps, Web Search, Settings)
2. **Verify:** Each page has a header with: small uppercase accent label (e.g., "MANAGE AGENTS") and a larger title
3. **Verify:** Action buttons (Create Agent, Add Connector) are right-aligned in headers
4. **Verify:** Header heights are consistent across pages

### 23.5 Empty States
1. Check empty states for: Agents (no agents), Chat (no conversations), Connectors (no connectors), Messaging Apps (no apps)
2. **Verify:** Each has an icon, descriptive text, and a call-to-action button
3. **Verify:** Empty state styling is consistent (centered, muted text, bordered/dashed container)

### 23.6 Cards & Spacing
1. Compare card styling across: Connector cards, Agent config cards, Messaging App cards
2. **Verify:** Consistent border color (border-border)
3. **Verify:** Consistent background (bg-card-bg)
4. **Verify:** Consistent internal padding
5. **Verify:** Consistent spacing between cards in lists

### 23.7 Typography
1. Compare text across all pages
2. **Verify:** Page titles use display font, ~22px, semibold
3. **Verify:** Section labels use monospace, ~11px, uppercase, wide tracking, accent color
4. **Verify:** Body text is ~14px (text-sm)
5. **Verify:** Code/API keys/tool names use monospace font
6. **Verify:** Muted/secondary text uses consistent muted color

### 23.8 Warning Banners
1. Compare credential warning banner (Chat) with MCP warning banner (Chat)
2. **Verify:** Both use the same yellow-900/30 background, yellow-700/50 border, yellow-200 text
3. **Verify:** Both have action buttons with consistent styling
4. **Verify:** Banner height and padding are consistent

### 23.9 Modal Consistency
1. Open modals: Add Key, Add Connector, Delete confirmation, Key Delete with reassignment
2. **Verify:** All modals have: semi-transparent black backdrop, centered white card
3. **Verify:** Close/X button in consistent position (top right)
4. **Verify:** Button row at bottom: Cancel (left/secondary), Confirm (right/primary)
5. **Verify:** All modals close on Escape key
6. **Verify:** All modals close on backdrop click

### 23.10 No Visual Defects
1. Resize the window to minimum reasonable size (~900x600)
2. **Verify:** No content overflow or horizontal scrollbars on any page
3. **Verify:** No text truncation that hides important information
4. **Verify:** No overlapping elements
5. Resize to a larger window
6. **Verify:** Content fills appropriately (no awkward whitespace)

---

## Section 24: Cross-Feature Integration

**Bootstrap:** These tests require specific state combinations. Each subsection has its own setup steps inline.

### 24.1 Credential Impact on Agents
1. Create an agent using the `default` Anthropic key
2. Navigate to AI Providers
3. Remove the `default` key (if it's the only key, the agent should show a warning)
4. Navigate to Agents list
5. **Verify:** The agent shows a yellow status dot
6. **Verify:** Inline warning text mentions missing credential
7. Navigate to Chat, select a conversation with that agent
8. **Verify:** Yellow banner: "This agent is missing an API key for Anthropic"
9. **Verify:** Chat input is disabled
10. Add the key back on AI Providers page
11. **Verify:** Agent status returns to green, banner disappears, input re-enabled

### 24.2 Settings → Create Agent Defaults
1. Navigate to Settings
2. Set a default model
3. Navigate to Create Agent wizard
4. **Verify:** The default model is pre-selected in the model dropdown

### 24.3 Key Deletion with Agent Reassignment
1. Ensure two keys exist for the same provider (e.g., `default` and `backup`)
2. Create an agent using `default`
3. Go to AI Providers, remove `default`
4. **Verify:** KeyDeleteModal appears showing the affected agent
5. **Verify:** Dropdown allows reassigning to `backup`
6. Select `backup`, confirm
7. **Verify:** Key deleted, agent now uses `backup` (check agent still runs)

---

## Section 25: Error Handling

### 25.1 Invalid Agent URL
1. Navigate to `/agents/nonexistent-id-12345` directly in the URL bar
2. **Verify:** "Agent not found" message with a back/home link

### 25.2 Long Content Handling
1. Create an agent with a very long name (50+ characters)
2. **Verify:** Name truncates gracefully in agents list (no layout break)
3. **Verify:** Full name visible on detail page

### 25.3 Special Characters
1. Create a conversation, rename it to include special characters: `<script>alert('xss')</script>`
2. **Verify:** The characters are displayed as text, not executed as HTML

---

## Section 26: Keyboard & Accessibility

### 26.1 Modal Escape
1. Open each modal type (Add Key, Add Connector, Delete confirmation)
2. Press Escape
3. **Verify:** Each modal closes without side effects

### 26.2 Form Tab Navigation
1. Open the Add Key modal
2. Press Tab repeatedly
3. **Verify:** Focus moves through form fields in logical order
4. **Verify:** Focus does not escape the modal while it's open

### 26.3 Chat Keyboard
1. In Chat, verify Enter sends, Shift+Enter adds newline
2. In inline rename fields (agent, conversation), verify Enter saves and Escape cancels

---

## Appendix: Test Run Log

| Run # | Date | Sections Tested | Pass | Fail | Bugs Filed | Notes |
|-------|------|-----------------|------|------|------------|-------|
|       |      |                 |      |      |            |       |
