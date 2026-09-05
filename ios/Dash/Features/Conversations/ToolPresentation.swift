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

  // MARK: - Result summary

  /// Removes the chrome some tools wrap their result body in, so a line
  /// count counts the body and not the envelope.
  ///
  /// `<path>`/`<type>` are dropped ELEMENT AND CONTENT — they are metadata
  /// the collapsed header already shows, and leaving the text behind would
  /// make a two-line file read as four. The remaining tags are pure
  /// wrappers, so only the tags go. Twin of tool-presentation.ts
  /// `stripResultChrome`; both descend from Mission Control's
  /// `stripXmlTags`.
  static func stripResultChrome(_ content: String) -> String {
    var out = content.replacingOccurrences(
      of: "<(path|type)>[\\s\\S]*?</\\1>\n?", with: "", options: .regularExpression)
    out = out.replacingOccurrences(
      of: "</?(?:entries|content|results)>\n?", with: "", options: .regularExpression)
    // `(?m)` rather than an option: `replacingOccurrences(options:)` takes
    // NSString.CompareOptions, which has no multiline member — that lives on
    // NSRegularExpression.Options, which this API never sees. The inline
    // flag is the same thing the JS twin spells as the /m regex flag.
    out = out.replacingOccurrences(
      of: "(?m)^FilePath:.*\n?", with: "", options: .regularExpression)
    out = out.replacingOccurrences(
      of: "(?m)^\\(\\d+ entries?\\)\n?", with: "", options: .regularExpression)
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Lines in `content`, ignoring leading and trailing blank lines. 0 for
  /// blank input — a trailing newline is an artifact of command output, not
  /// a line of it.
  static func countLines(_ content: String) -> Int {
    let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? 0 : trimmed.components(separatedBy: "\n").count
  }

  private static func firstLine(_ content: String) -> String {
    for line in content.components(separatedBy: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if !trimmed.isEmpty { return trimmed }
    }
    return ""
  }

  private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
    "\(n) \(n == 1 ? one : many)"
  }

  /// Human byte size: `512 B`, `4.2 KB`, `1.3 MB`.
  static func formatBytes(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
    return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
  }

  /// `+added -removed` from an edit tool's `details.diff`, or nil when there
  /// is no usable diff. `+++`/`---` are unified-diff FILE HEADERS, not
  /// content, so they are excluded — counting them would report every
  /// one-line edit as `+2 -2`. The hyphen is ASCII U+002D, not a U+2212
  /// minus: three platforms render this string and an encoding is one more
  /// thing they could disagree about.
  static func diffStat(_ details: JSONValue?) -> String? {
    guard case let .object(fields)? = details,
      case let .string(diff)? = fields["diff"], !diff.isEmpty
    else { return nil }
    var added = 0
    var removed = 0
    for line in diff.components(separatedBy: "\n") {
      if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
      if line.hasPrefix("+") {
        added += 1
      } else if line.hasPrefix("-") {
        removed += 1
      }
    }
    guard added > 0 || removed > 0 else { return nil }
    return "+\(added) -\(removed)"
  }

  /// What came back, for the right edge of a collapsed tool row — the half
  /// of the card `summarize` cannot answer, because `summarize` reads only
  /// the tool's INPUT.
  ///
  /// Replaces `outcomeSummary`, which reported the payload's line count and
  /// nothing else: size is a property of the transport, whereas "12 matches"
  /// or "no matches" is the answer to the question the user actually asked.
  ///
  /// Heuristic by necessity — the backend flattens a tool's content blocks
  /// into one opaque string, so there is nothing structured to read. Every
  /// branch is keyed to a shape this repo's own tools emit; the fallback is
  /// deliberately dull, because a third-party MCP tool's output is only
  /// reliably "some text". Twin of tool-presentation.ts `resultSummary`,
  /// pinned against it by the shared fixture corpus.
  static func resultSummary(
    name: String, content: String?, isError: Bool = false, details: JSONValue? = nil
  ) -> String? {
    guard let content else { return nil }

    if isError {
      let line = firstLine(content)
      return line.isEmpty ? "failed" : middleTruncate(line, max: 40)
    }

    // A task card's header already reads "2/3 done" plus the active item,
    // and its body is a rendered checklist. An outcome would be a third
    // account of the same thing.
    if isTodoWrite(name) { return nil }

    let normalized = normalizeTool(name)
    if normalized == "edit" { return diffStat(details) }

    let body = stripResultChrome(content)

    switch normalized {
    case "read":
      return plural(countLines(body), "line", "lines")
    case "ls":
      // The listing tool states its own count; trust it over a line count,
      // which would also count any header or trailing note.
      return plural(declaredEntryCount(content) ?? countLines(body), "entry", "entries")
    case "grep", "find":
      let matches = countLines(body)
      return matches == 0 ? "no matches" : plural(matches, "match", "matches")
    case "web_search":
      let results = numberedResultCount(body)
      return results == 0 ? "no results" : plural(results, "result", "results")
    case "web_fetch":
      return formatBytes(body.utf8.count)
    default:
      let lines = countLines(body)
      if lines == 0 { return "no output" }
      // One short line IS the outcome — "ok", "done", an exit message.
      // Saying "1 line" instead would be strictly less information for the
      // same width.
      if lines == 1, body.count <= 40 { return body }
      return plural(lines, "line", "lines")
    }
  }

  private static func declaredEntryCount(_ content: String) -> Int? {
    guard let range = content.range(of: "\\((\\d+) entries?\\)", options: .regularExpression)
    else { return nil }
    return Int(content[range].filter(\.isNumber))
  }

  private static func numberedResultCount(_ body: String) -> Int {
    body.components(separatedBy: "\n").filter {
      $0.range(of: "^\\d+\\. \\[", options: .regularExpression) != nil
    }.count
  }

  // MARK: - Detail formatting

  struct ToolDetail: Equatable {
    let key: String
    let value: String
  }

  private static let readSkipKeys: Set<String> = ["path", "offset", "limit"]
  private static let writeSkipKeys: Set<String> = ["content"]

  /// Key/value detail rows for a tool's expanded body, filtered down to the
  /// rows that tell the reader something.
  ///
  /// Three rules. The read tool's `path`/`offset`/`limit` and the write
  /// tool's `content` are skipped, as before — those are shown elsewhere.
  /// A row whose value is exactly the header summary is dropped as pure
  /// duplication. A row whose value is `{object}` or `[N items]` is dropped
  /// because it reports the input's type and never its content.
  ///
  /// Twin of tool-presentation.ts `formatVisibleDetails`; iOS keeps the
  /// filtering fused into `formatDetails` because there is no second call
  /// site here that wants the unfiltered list (see type doc).
  ///
  /// PARITY HAZARD, deliberately accepted: the duplicate rule compares
  /// against `summarize`, whose last resort is "first string value in the
  /// object" — sorted-key order here, insertion order on web. That
  /// divergence used to be cosmetic and is now load-bearing: for a tool with
  /// no primary key and two or more string inputs, the platforms can pick
  /// different summaries and drop different rows. Such a tool is by
  /// definition one this repo does not know, and the row is still shown on
  /// one platform rather than lost, so the cost is cosmetic. Fixing it means
  /// giving `summarize` a deterministic fallback on both sides, which
  /// changes MC-parity behaviour predating this work.
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

    let summary = summarize(name: name, input: input)

    return fields.keys.sorted().compactMap { key in
      guard !skipKeys.contains(key) else { return nil }
      let value = formatDetailValue(fields[key]!)
      // Pure duplication: the header sits directly above this row. Equality
      // against `summarize` rather than "drop the primary key" makes the
      // rule self-correcting — a truncated or shortened summary does not
      // match, so the full value stays reachable here.
      if let summary, value == summary { return nil }
      // Reports the input's TYPE and never its content. "Todos: [3 items]"
      // was the agent's plan rendered as its own array length.
      if isPlaceholderValue(value) { return nil }
      return ToolDetail(key: key, value: value)
    }
  }

  private static func isPlaceholderValue(_ value: String) -> Bool {
    value == "{object}"
      || value.range(of: "^\\[\\d+ items?\\]$", options: .regularExpression) != nil
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
