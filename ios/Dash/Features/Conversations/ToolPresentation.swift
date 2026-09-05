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

  /// Truncates `s` to `max` characters. For path-like strings, uses a
  /// middle-ellipsis that preserves the trailing filename (mirrors
  /// chat.helpers.ts `truncate`).
  ///
  /// Divergence from the web source (chat UI polish 2026-09-05): "path-like"
  /// here additionally requires the string to be whitespace-free. The web
  /// version keys the middle-ellipsis off `includes('/')` alone, which is
  /// fine for the `path`/`url` fields it was written for but wrong for
  /// `bash`'s `command` — a shell line's LAST slash usually sits inside a
  /// trailing argument, so the branch spliced the command's head onto that
  /// argument's tail and produced a plausible-looking path
  /// ("/opt/homebrew/bin/gog gmail li…/out.json") that never existed. A
  /// string with spaces in it is a sentence or a command, not a path, and
  /// plain tail truncation is the honest rendering.
  static func middleTruncate(_ s: String, max: Int = 60) -> String {
    guard s.count > max else { return s }

    if isPathLike(s), let lastSlash = s.lastIndex(of: "/") {
      let filename = String(s[lastSlash...])  // includes the leading /
      let prefixMaxLength = max - filename.count - 1
      if prefixMaxLength > 3 {
        let prefix = String(s.prefix(prefixMaxLength))
        return "\(prefix)…\(filename)"
      }
    }

    return "\(s.prefix(max))…"
  }

  private static func isPathLike(_ s: String) -> Bool {
    s.contains("/") && s.contains(where: \.isWhitespace) == false
  }

  // MARK: - Command shortening

  /// Drops the leading directory from a shell command's executable, so
  /// `/opt/homebrew/bin/gog gmail list` summarizes as `gog gmail list`.
  ///
  /// Collapsed tool rows get roughly 40 characters on a phone. An absolute
  /// launcher path spends the first ~18 of those on a prefix that is
  /// identical across every call to the same binary, which is exactly the
  /// state the conversation view was in: three consecutive `gog` calls that
  /// were indistinguishable until you expanded them. The directory is not
  /// information the reader is missing — it is on `$PATH` — so it goes,
  /// and the arguments that actually differ move into view.
  ///
  /// Only the first whitespace-delimited word is touched, and only when it
  /// reads as a launcher path (absolute, `./`, `../`, or `~/`). Everything
  /// after it is preserved byte-for-byte: `cd /Users/gerry/x && npm test`
  /// keeps its path, because that path is an argument the user chose, not
  /// an install location.
  static func shortenCommand(_ command: String) -> String {
    let executableEnd = command.firstIndex(where: \.isWhitespace) ?? command.endIndex
    let executable = command[command.startIndex..<executableEnd]
    guard
      executable.hasPrefix("/") || executable.hasPrefix("./") || executable.hasPrefix("../")
        || executable.hasPrefix("~/"),
      let lastSlash = executable.lastIndex(of: "/")
    else { return command }

    let name = executable[executable.index(after: lastSlash)...]
    guard !name.isEmpty else { return command }
    return String(name) + String(command[executableEnd...])
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

  /// The single in-progress task's content, for a collapsed task card's
  /// header — truncated to 40 characters so it cannot crowd the row.
  ///
  /// `summarize` already returns "2/3 done" for a todo write (MC parity, do
  /// not change it). This is the iOS-only companion: on a phone-width card
  /// "2/3 done" tells you how far along the agent is but not what it is
  /// doing, which is the more useful of the two. Mission Control shows the
  /// same thing on its collapsed pinned panel.
  ///
  /// Deterministic when the agent misbehaves and marks several items in
  /// progress: takes the first in list order, so the header does not flicker
  /// between them across renders.
  static func activeTodoContent(_ input: JSONValue?) -> String? {
    guard let todos = parseTodos(input) else { return nil }
    guard let active = todos.first(where: { $0.status == "in_progress" }) else { return nil }
    return middleTruncate(active.content, max: 40)
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

    let normalized = normalizeTool(name)
    let keys = primaryKeys[normalized] ?? []
    for key in keys {
      if case let .string(value)? = fields[key], !value.isEmpty {
        // Shorten BEFORE truncating: otherwise `/opt/homebrew/bin/` spends
        // 18 of the 60-character budget before the command even starts.
        return middleTruncate(normalized == "bash" ? shortenCommand(value) : value)
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

  // MARK: - Collapsed outcome

  /// How much output a finished tool produced, for the right edge of its
  /// collapsed header — `nil` when there is nothing worth saying.
  ///
  /// An iOS-only addition, not part of the MC parity surface: the web cards
  /// are wide enough to preview output inline, whereas here a collapsed card
  /// shows a status dot and a command, and nothing distinguishes "expanding
  /// this reveals 200 lines of log" from "expanding this reveals nothing at
  /// all". A single-line result stays silent — "1 line" is not worth the
  /// pixels, and the row is already narrow.
  static func outcomeSummary(content: String?) -> String? {
    guard let content, content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    else { return nil }
    // Trailing newlines are an artifact of command output, not a line of it.
    let lines = content.trimmingCharacters(in: .newlines).components(separatedBy: "\n").count
    guard lines > 1 else { return nil }
    return "\(lines) lines"
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
        ? formatIntegralNumber(n) : String(n)
    case let .bool(b):
      return b ? "true" : "false"
    case .null:
      return "null"
    }
  }

  /// Formats an integral `Double` the way JavaScript's `String(n)` does.
  ///
  /// For values that fit in `Int` (`Int.min...Int.max`), this is just
  /// `String(Int(n))` — `Int(exactly:)` never fails there. Outside that
  /// range — e.g. a 20-digit tool-input ID that round-trips through JSON as
  /// a `Number` — `Int(n)` (the previous implementation) traps, and even a
  /// non-trapping conversion would diverge from web: ECMA-262's
  /// `Number::toString` still prints plain fixed-notation digits (with
  /// trailing zeros for precision the double doesn't have) as long as the
  /// value's magnitude is below 1e21, only switching to exponential
  /// notation at 1e21 and beyond. Swift's `String(Double)` always uses
  /// exponential notation once the value leaves `Int64` range
  /// (`"1.2345678901234567e+19"`), which would silently render a different
  /// string than the web client for these edge-case IDs.
  ///
  /// So: for the below-1e21 range, we take Swift's shortest-round-trip
  /// scientific-notation digits (`String(n)`) and reformat them into plain
  /// digits + zero padding, replicating the ECMA-262 fixed-notation rule
  /// (digit count `k` <= decimal-point position `n` <= 21). Both platforms'
  /// `Double` use the same shortest-round-trip digit-selection algorithm,
  /// so the digit *sequence* always matches — only the notation (fixed vs.
  /// scientific) differs, which is what this function corrects. Beyond
  /// 1e21 both platforms use exponential notation, but this function
  /// doesn't attempt to pin the exact exponential formatting (unreachable
  /// via realistic tool-input IDs); it falls back to Swift's own
  /// `String(Double)` there.
  static func formatIntegralNumber(_ n: Double) -> String {
    if let i = Int(exactly: n) {
      return String(i)
    }
    let description = String(n)  // e.g. "1.2345678901234567e+19"
    guard
      let eIndex = description.firstIndex(where: { $0 == "e" || $0 == "E" }),
      let exponent = Int(description[description.index(after: eIndex)...])
    else {
      return description
    }
    let mantissa = description[description.startIndex..<eIndex]
    let isNegative = mantissa.hasPrefix("-")
    let unsignedMantissa = isNegative ? String(mantissa.dropFirst()) : String(mantissa)
    let digits = unsignedMantissa.replacingOccurrences(of: ".", with: "")
    // ECMA-262's "n": the digit sequence's decimal-point position, counted
    // from the left (mantissa is d.ddd form, so this is exponent + 1).
    let pointPosition = exponent + 1

    guard digits.count <= pointPosition, pointPosition <= 21 else {
      return description
    }

    let zerosToAppend = pointPosition - digits.count
    let fixed = digits + String(repeating: "0", count: zerosToAppend)
    return isNegative ? "-\(fixed)" : fixed
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
