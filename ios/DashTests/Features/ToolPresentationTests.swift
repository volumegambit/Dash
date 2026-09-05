import Foundation
import Testing

@testable import Dash

@Suite("Tool presentation (MC parity port)")
struct ToolPresentationTests {

  // MARK: - toolLabel

  @Test(
    "toolLabel maps every known tool name to its MC label",
    arguments: [
      ("bash", "Bash"),
      ("read", "Read"),
      ("write", "Write"),
      ("edit", "Edit"),
      ("find", "Find"),
      ("grep", "Grep"),
      ("ls", "List Directory"),
      ("web_search", "Web Search"),
      ("web_fetch", "Web Fetch"),
      ("task", "Task"),
      ("load_skill", "Load Skill"),
      ("create_skill", "Create Skill"),
    ]
  )
  func toolLabelKnownTools(name: String, expected: String) {
    #expect(ToolPresentation.toolLabel(name) == expected)
  }

  @Test(
    "toolLabel normalizes legacy names before mapping",
    arguments: [
      ("read_file", "Read"),
      ("write_file", "Write"),
      ("list_directory", "List Directory"),
      ("execute_command", "Bash"),
    ]
  )
  func toolLabelLegacyNames(name: String, expected: String) {
    #expect(ToolPresentation.toolLabel(name) == expected)
  }

  @Test("toolLabel falls back to a capitalized raw name for unknown tools")
  func toolLabelUnknownTool() {
    #expect(ToolPresentation.toolLabel("search") == "Search")
    #expect(ToolPresentation.toolLabel("custom_thing") == "Custom_thing")
  }

  // MARK: - middleTruncate

  @Test("middleTruncate leaves short strings untouched")
  func middleTruncateShortString() {
    #expect(ToolPresentation.middleTruncate("ls -la") == "ls -la")
  }

  @Test("middleTruncate trailing-ellipsizes long non-path strings")
  func middleTruncateLongPlainString() {
    let long = String(repeating: "a", count: 70)
    let result = ToolPresentation.middleTruncate(long)
    #expect(result.count == 61)
    #expect(result.hasSuffix("…"))
  }

  @Test("middleTruncate preserves the filename for long paths")
  func middleTruncateLongPath() {
    let longPath =
      "/Users/gerry/Projects/claude-workspace/Projects/Dash/apps/mission-control/src/renderer/src/routes/deploy.tsx"
    let result = ToolPresentation.middleTruncate(longPath)
    #expect(result.hasSuffix("/deploy.tsx"))
    #expect(result.contains("…"))
    #expect(result.count <= 61)
  }

  // MARK: - middleTruncate is path-aware only for actual paths

  @Test("middleTruncate never splices a whitespace-bearing command around its last slash")
  func middleTruncateDoesNotSpliceCommands() {
    // Regression (chat UI polish 2026-09-05): the slash branch assumed
    // "contains /" meant "is a path". For a shell command whose LAST slash
    // sits in a trailing argument, it spliced the command's head onto that
    // argument's tail — "/opt/homebrew/bin/gog gmail li…/out.json" — a
    // summary that reads as a path neither the user nor the agent ever used.
    let command =
      "/opt/homebrew/bin/gog gmail list --query unread --limit 50 --format json --out /tmp/out.json"
    let result = ToolPresentation.middleTruncate(command)
    #expect(result.hasSuffix("…"))
    #expect(result.hasSuffix("/tmp/out.json") == false)
    #expect(result.count == 61)
  }

  // MARK: - shortenCommand

  @Test("shortenCommand strips the executable's leading directory")
  func shortenCommandStripsBinaryDirectory() {
    #expect(
      ToolPresentation.shortenCommand("/opt/homebrew/bin/gog gmail list \"in:inbox\"")
        == "gog gmail list \"in:inbox\""
    )
  }

  @Test("shortenCommand handles a bare executable path with no arguments")
  func shortenCommandBareExecutable() {
    #expect(ToolPresentation.shortenCommand("/usr/local/bin/wrangler") == "wrangler")
  }

  @Test(
    "shortenCommand leaves commands whose first word is not a path untouched",
    arguments: [
      "ls -la",
      "npm run build",
      "cd /Users/gerry/Projects && npm test",
      "grep -rn foo src/",
      "",
    ]
  )
  func shortenCommandLeavesNonPathsUntouched(command: String) {
    #expect(ToolPresentation.shortenCommand(command) == command)
  }

  @Test("shortenCommand keeps relative and home-relative launches recognizable")
  func shortenCommandRelativeLaunchers() {
    #expect(ToolPresentation.shortenCommand("./scripts/build.sh --watch") == "build.sh --watch")
    #expect(ToolPresentation.shortenCommand("~/bin/deploy prod") == "deploy prod")
  }

  @Test("shortenCommand preserves interior whitespace of the arguments")
  func shortenCommandPreservesArguments() {
    #expect(
      ToolPresentation.shortenCommand("/bin/echo  a   b") == "echo  a   b"
    )
  }

  @Test("shortenCommand does not strip a trailing-slash-only first word")
  func shortenCommandTrailingSlash() {
    #expect(ToolPresentation.shortenCommand("/usr/bin/ arg") == "/usr/bin/ arg")
  }

  // MARK: - summarize

  @Test("summarize strips the binary directory from a bash command")
  func summarizeBashStripsBinaryDirectory() {
    // The screenshot case: three consecutive gog calls whose first 18
    // characters were identical, so the collapsed rows were indistinguishable.
    #expect(
      ToolPresentation.summarize(
        name: "bash",
        input: .object(["command": .string("/opt/homebrew/bin/gog gmail list \"in:inbox\"")])
      ) == "gog gmail list \"in:inbox\""
    )
  }

  @Test("summarize shortens the command before truncating, not after")
  func summarizeBashShortensBeforeTruncating() {
    // 18 chars of "/opt/homebrew/bin/" must not eat into the 60-char budget.
    let arguments = String(repeating: "x", count: 55)
    let result = ToolPresentation.summarize(
      name: "bash",
      input: .object(["command": .string("/opt/homebrew/bin/gog \(arguments)")])
    )
    #expect(result == "gog \(arguments)")
  }

  @Test("summarize applies command shortening to the legacy execute_command name")
  func summarizeLegacyExecuteCommand() {
    #expect(
      ToolPresentation.summarize(
        name: "execute_command",
        input: .object(["command": .string("/opt/homebrew/bin/gog auth list")])
      ) == "gog auth list"
    )
  }


  @Test("summarize extracts the command for bash")
  func summarizeBash() {
    #expect(
      ToolPresentation.summarize(name: "bash", input: .object(["command": .string("ls -la")]))
        == "ls -la"
    )
  }

  @Test("summarize truncates a command longer than 60 chars")
  func summarizeTruncatesLongCommand() {
    let long = String(repeating: "a", count: 70)
    let result = ToolPresentation.summarize(name: "bash", input: .object(["command": .string(long)]))
    #expect(result?.count == 61)
    #expect(result?.hasSuffix("…") == true)
  }

  @Test("summarize middle-ellipsizes long file paths")
  func summarizeLongPath() {
    let longPath =
      "/Users/gerry/Projects/claude-workspace/Projects/Dash/apps/mission-control/src/renderer/src/routes/deploy.tsx"
    let result = ToolPresentation.summarize(name: "read", input: .object(["path": .string(longPath)]))
    #expect(result?.contains("/deploy.tsx") == true)
    #expect(result?.contains("…") == true)
  }

  @Test("summarize extracts path for write")
  func summarizeWritePath() {
    #expect(
      ToolPresentation.summarize(
        name: "write",
        input: .object(["path": .string("src/index.ts"), "content": .string("hello")])
      ) == "src/index.ts"
    )
  }

  @Test("summarize extracts path for read")
  func summarizeReadPath() {
    #expect(
      ToolPresentation.summarize(name: "read", input: .object(["path": .string("package.json")]))
        == "package.json"
    )
  }

  @Test("summarize extracts query for web_search")
  func summarizeWebSearch() {
    #expect(
      ToolPresentation.summarize(
        name: "web_search", input: .object(["query": .string("TypeScript generics")])
      ) == "TypeScript generics"
    )
  }

  @Test("summarize extracts url for web_fetch")
  func summarizeWebFetch() {
    #expect(
      ToolPresentation.summarize(
        name: "web_fetch", input: .object(["url": .string("https://example.com")])
      ) == "https://example.com"
    )
  }

  @Test("summarize falls back to the second primary key when the first is absent")
  func summarizeGrepFallsBackToQuery() {
    #expect(
      ToolPresentation.summarize(name: "grep", input: .object(["query": .string("useState")]))
        == "useState"
    )
  }

  @Test("summarize falls back to the sole string value for an unknown tool")
  func summarizeUnknownToolFallback() {
    #expect(
      ToolPresentation.summarize(name: "unknown_tool", input: .object(["foo": .string("bar")]))
        == "bar"
    )
  }

  @Test("summarize returns nil when input is nil")
  func summarizeNilInput() {
    #expect(ToolPresentation.summarize(name: "bash", input: nil) == nil)
  }

  @Test("summarize returns nil when no matching key is found")
  func summarizeNoMatch() {
    #expect(ToolPresentation.summarize(name: "ls", input: .object([:])) == nil)
  }

  @Test("summarize reports done/total for TodoWrite")
  func summarizeTodoWrite() {
    let todos = JSONValue.array([
      .object(["content": .string("a"), "status": .string("completed")]),
      .object(["content": .string("b"), "status": .string("pending")]),
      .object(["content": .string("c"), "status": .string("completed")]),
    ])
    #expect(
      ToolPresentation.summarize(name: "task", input: .object(["todos": todos])) == "2/3 done"
    )
  }

  // MARK: - outcomeSummary

  @Test("outcomeSummary counts the lines of a multi-line result")
  func outcomeSummaryMultiline() {
    #expect(ToolPresentation.outcomeSummary(content: "a\nb\nc") == "3 lines")
  }

  @Test("outcomeSummary ignores a trailing newline from command output")
  func outcomeSummaryTrailingNewline() {
    #expect(ToolPresentation.outcomeSummary(content: "a\nb\n") == "2 lines")
  }

  @Test(
    "outcomeSummary stays silent when there is nothing worth reporting",
    arguments: [nil, "", "   ", "\n", "one line", "one line\n"]
  )
  func outcomeSummarySilent(content: String?) {
    #expect(ToolPresentation.outcomeSummary(content: content) == nil)
  }

  // MARK: - formatDetails

  @Test("formatDetails returns short strings as-is")
  func formatDetailsShortString() {
    let result = ToolPresentation.formatDetails(
      name: "grep", input: .object(["query": .string("useState")]))
    #expect(result == [ToolPresentation.ToolDetail(key: "query", value: "useState")])
  }

  @Test("formatDetails truncates long strings with a char count")
  func formatDetailsLongString() {
    let long = String(repeating: "x", count: 100)
    let result = ToolPresentation.formatDetails(
      name: "grep", input: .object(["note": .string(long)]))
    #expect(result.count == 1)
    #expect(result[0].key == "note")
    #expect(result[0].value.contains("(100 chars)"))
    #expect(result[0].value.contains("…"))
  }

  @Test("formatDetails formats arrays as [N items]")
  func formatDetailsArray() {
    let result = ToolPresentation.formatDetails(
      name: "grep", input: .object(["files": .array([.string("a"), .string("b"), .string("c")])]))
    #expect(result == [ToolPresentation.ToolDetail(key: "files", value: "[3 items]")])
  }

  @Test("formatDetails formats nested objects as {object}")
  func formatDetailsNestedObject() {
    let result = ToolPresentation.formatDetails(
      name: "grep", input: .object(["opts": .object(["a": .number(1)])]))
    #expect(result == [ToolPresentation.ToolDetail(key: "opts", value: "{object}")])
  }

  @Test("formatDetails skips path/offset/limit for read")
  func formatDetailsSkipsReadKeys() {
    let result = ToolPresentation.formatDetails(
      name: "read",
      input: .object([
        "path": .string("a.txt"),
        "offset": .number(10),
        "limit": .number(20),
        "reason": .string("checking contents"),
      ])
    )
    #expect(result == [ToolPresentation.ToolDetail(key: "reason", value: "checking contents")])
  }

  @Test("formatDetails skips content for write")
  func formatDetailsSkipsWriteContent() {
    let result = ToolPresentation.formatDetails(
      name: "write",
      input: .object(["path": .string("a.txt"), "content": .string("hello world")])
    )
    #expect(result == [ToolPresentation.ToolDetail(key: "path", value: "a.txt")])
  }

  @Test("formatDetails returns multiple key/value pairs sorted by key")
  func formatDetailsMultiplePairs() {
    let result = ToolPresentation.formatDetails(
      name: "grep", input: .object(["path": .string("foo.ts"), "mode": .string("write")]))
    #expect(
      result == [
        ToolPresentation.ToolDetail(key: "mode", value: "write"),
        ToolPresentation.ToolDetail(key: "path", value: "foo.ts"),
      ]
    )
  }

  @Test("formatDetails returns empty for nil input")
  func formatDetailsNilInput() {
    #expect(ToolPresentation.formatDetails(name: "bash", input: nil) == [])
  }

  @Test("formatDetails falls back to a single 'input' row for non-object JSON")
  func formatDetailsNonObjectInput() {
    let result = ToolPresentation.formatDetails(name: "bash", input: .number(42))
    #expect(result == [ToolPresentation.ToolDetail(key: "input", value: "42")])
  }

  // MARK: - isTodoWrite / parseTodos

  @Test(
    "isTodoWrite recognizes task and todowrite, normalized",
    arguments: [
      ("task", true),
      ("todowrite", true),
      ("TodoWrite", true),
      ("bash", false),
    ]
  )
  func isTodoWriteRecognizesNames(name: String, expected: Bool) {
    #expect(ToolPresentation.isTodoWrite(name) == expected)
  }

  @Test("parseTodos extracts structured items, dropping entries without string content")
  func parseTodosExtractsItems() {
    let input = JSONValue.object([
      "todos": .array([
        .object(["id": .string("1"), "content": .string("Write tests"), "status": .string("completed")]),
        .object(["content": .number(5)]),
        .object(["content": .string("Ship it")]),
      ])
    ])
    let todos = ToolPresentation.parseTodos(input)
    #expect(todos?.count == 2)
    #expect(todos?[0] == ToolPresentation.ToolTodoItem(id: "1", content: "Write tests", status: "completed"))
    #expect(todos?[1] == ToolPresentation.ToolTodoItem(id: nil, content: "Ship it", status: "pending"))
  }

  @Test("parseTodos returns nil when todos is missing or empty")
  func parseTodosNilCases() {
    #expect(ToolPresentation.parseTodos(.object([:])) == nil)
    #expect(ToolPresentation.parseTodos(.object(["todos": .array([])])) == nil)
    #expect(ToolPresentation.parseTodos(nil) == nil)
  }
}
