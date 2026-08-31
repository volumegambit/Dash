import Foundation

/// Swift port of Mission Control's tool-card presentation helpers
/// (`apps/mission-control/src/renderer/src/routes/chat.helpers.ts`) — design
/// doc appendix §3 is BINDING for tool label mapping, primary-field
/// summarization, truncation, and detail formatting rules.
///
/// One deliberate divergence from the web source: `formatDetails` there
/// takes a raw JSON *string* and the read/write key-skip filtering happens
/// at the ToolBlock call site; here both are fused into one function because
/// the iOS pipeline already hands us a parsed `JSONValue` (see
/// `ToolCardState.input`), and iOS has no separate call site that needs the
/// unfiltered list.
///
/// Another divergence: `Object.entries`/`Object.values` iterate a JS
/// object's string keys in insertion order, which the "fallback to first
/// string value" and detail-listing behaviors rely on. `JSONValue.object`
/// is a Swift `[String: JSONValue]`, which has no defined iteration order —
/// so those two operations here iterate keys sorted alphabetically instead,
/// for deterministic (if not insertion-order-identical) output.
enum ToolPresentation {

  // MARK: - Tool name normalization + label

  /// Normalizes legacy tool names (`read_file`, `write_file`, ...) to their
  /// canonical form. Mirrors chat.helpers.ts `normalizeTool`.
  static func normalizeTool(_ name: String) -> String {
    switch name {
    case "read_file": "read"
    case "write_file": "write"
    case "list_directory": "ls"
    case "execute_command": "bash"
    case "TodoWrite": "todowrite"
    default: name
    }
  }

  private static let toolLabels: [String: String] = [
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "find": "Find",
    "grep": "Grep",
    "ls": "List Directory",
    "web_search": "Web Search",
    "web_fetch": "Web Fetch",
    "task": "Task",
    "load_skill": "Load Skill",
    "create_skill": "Create Skill",
  ]

  /// Human-friendly label for a tool name. Unknown tools fall back to their
  /// raw name, capitalized.
  static func toolLabel(_ name: String) -> String {
    let normalized = normalizeTool(name)
    if let label = toolLabels[normalized] { return label }
    guard let first = name.first else { return name }
    return first.uppercased() + name.dropFirst()
  }

  // MARK: - Truncation

  /// Truncates `s` to `max` characters. For strings containing `/`, uses a
  /// middle-ellipsis that preserves the trailing filename (mirrors
  /// chat.helpers.ts `truncate`).
  static func middleTruncate(_ s: String, max: Int = 60) -> String {
    guard s.count > max else { return s }

    if s.contains("/"), let lastSlash = s.lastIndex(of: "/") {
      let filename = String(s[lastSlash...])  // includes the leading /
      let prefixMaxLength = max - filename.count - 1
      if prefixMaxLength > 3 {
        let prefix = String(s.prefix(prefixMaxLength))
        return "\(prefix)…\(filename)"
      }
    }

    return "\(s.prefix(max))…"
  }

  // MARK: - TodoWrite

  struct ToolTodoItem: Equatable {
    let id: String?
    let content: String
    let status: String
  }

  /// True when `name` normalizes to the TodoWrite tool.
  static func isTodoWrite(_ name: String) -> Bool {
    let normalized = normalizeTool(name)
    return normalized == "task" || normalized == "todowrite"
  }

  /// Parses a `{ "todos": [...] }` tool input into structured todo items, or
  /// `nil` if `todos` is missing, non-array, or empty. Items without a
  /// string `content` field are dropped (mirrors chat.helpers.ts
  /// `parseTodos`).
  static func parseTodos(_ input: JSONValue?) -> [ToolTodoItem]? {
    guard case let .object(fields)? = input,
      case let .array(rawTodos)? = fields["todos"],
      !rawTodos.isEmpty
    else { return nil }

    return rawTodos.compactMap { todo -> ToolTodoItem? in
      guard case let .object(todoFields) = todo,
        case let .string(content)? = todoFields["content"]
      else { return nil }
      let id: String? = if case let .string(value)? = todoFields["id"] { value } else { nil }
      let status: String =
        if case let .string(value)? = todoFields["status"] { value } else { "pending" }
      return ToolTodoItem(id: id, content: content, status: status)
    }
  }

  // MARK: - Summarize

  private static let primaryKeys: [String: [String]] = [
    "bash": ["command"],
    "write": ["path"],
    "edit": ["path"],
    "read": ["path"],
    "find": ["pattern"],
    "grep": ["pattern", "query"],
    "ls": ["path", "directory"],
    "web_search": ["query"],
    "web_fetch": ["url"],
    "task": ["todos"],
    "load_skill": ["name"],
    "create_skill": ["name"],
  ]

  /// One-line inline summary for a tool's collapsed header, or `nil` when
  /// there's nothing to show. Mirrors chat.helpers.ts `summarize`.
  static func summarize(name: String, input: JSONValue?) -> String? {
    guard case let .object(fields)? = input else { return nil }

    if isTodoWrite(name), let todos = parseTodos(input) {
      let done = todos.filter { $0.status == "completed" }.count
      return "\(done)/\(todos.count) done"
    }

    let keys = primaryKeys[normalizeTool(name)] ?? []
    for key in keys {
      if case let .string(value)? = fields[key], !value.isEmpty {
        return middleTruncate(value)
      }
    }

    // Fallback: first string value in the object, by sorted key (see type
    // doc — Swift dictionaries have no insertion order to fall back on).
    for key in fields.keys.sorted() {
      if case let .string(value) = fields[key]!, !value.isEmpty {
        return middleTruncate(value)
      }
    }

    return nil
  }

  // MARK: - Detail formatting

  struct ToolDetail: Equatable {
    let key: String
    let value: String
  }

  private static let readSkipKeys: Set<String> = ["path", "offset", "limit"]
  private static let writeSkipKeys: Set<String> = ["content"]

  /// Key/value detail rows for a tool's expanded body, with the read tool's
  /// `path`/`offset`/`limit` and the write tool's `content` keys skipped
  /// (those are already shown elsewhere — the summary, or a rich content
  /// preview on platforms that have one). Mirrors chat.helpers.ts
  /// `formatDetails` fused with the read/write filtering that lives at the
  /// ToolBlock call site on web (see type doc).
  static func formatDetails(name: String, input: JSONValue?) -> [ToolDetail] {
    guard let input else { return [] }

    guard case let .object(fields) = input else {
      return [ToolDetail(key: "input", value: rawJSONString(input))]
    }

    let skipKeys: Set<String>
    switch normalizeTool(name) {
    case "read": skipKeys = readSkipKeys
    case "write": skipKeys = writeSkipKeys
    default: skipKeys = []
    }

    return fields.keys.sorted().compactMap { key in
      guard !skipKeys.contains(key) else { return nil }
      return ToolDetail(key: key, value: formatDetailValue(fields[key]!))
    }
  }

  private static func formatDetailValue(_ value: JSONValue) -> String {
    switch value {
    case let .string(s):
      if s.count > 80 {
        let prefix = String(s.prefix(80))
        return "\"\(prefix)…\" (\(s.count) chars)"
      }
      return s
    case let .array(items):
      return "[\(items.count) items]"
    case .object:
      return "{object}"
    case let .number(n):
      return n.truncatingRemainder(dividingBy: 1) == 0
        ? String(Int(n)) : String(n)
    case let .bool(b):
      return b ? "true" : "false"
    case .null:
      return "null"
    }
  }

  private static func rawJSONString(_ value: JSONValue) -> String {
    guard
      let data = try? ContractCoding.encoder().encode(value),
      let string = String(data: data, encoding: .utf8)
    else {
      return ""
    }
    return string
  }
}
