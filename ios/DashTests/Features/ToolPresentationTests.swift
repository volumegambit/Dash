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

  // MARK: - summarize

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
