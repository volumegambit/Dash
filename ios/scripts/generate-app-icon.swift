import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum AppIconRasterError: Error, CustomStringConvertible {
  case usage
  case malformed(String)
  case cannotCreateContext
  case cannotCreateImage
  case cannotWrite

  var description: String {
    switch self {
    case .usage:
      return "usage: generate-app-icon <source.svg> <output.png>"
    case let .malformed(detail):
      return "malformed pinned SVG: \(detail)"
    case .cannotCreateContext:
      return "could not create opaque RGB bitmap context"
    case .cannotCreateImage:
      return "could not create AppIcon image"
    case .cannotWrite:
      return "could not write AppIcon PNG"
    }
  }
}

func captures(_ pattern: String, in value: String) throws -> [[String]] {
  let expression = try NSRegularExpression(pattern: pattern)
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return expression.matches(in: value, range: range).map { match in
    (1..<match.numberOfRanges).compactMap { index in
      guard let range = Range(match.range(at: index), in: value) else { return nil }
      return String(value[range])
    }
  }
}

func colorComponents(_ source: String) throws -> (CGFloat, CGFloat, CGFloat) {
  var hex = source.lowercased()
  guard hex.first == "#" else {
    throw AppIconRasterError.malformed("color \(source)")
  }
  hex.removeFirst()
  if hex.count == 3 {
    hex = hex.map { "\($0)\($0)" }.joined()
  }
  guard hex.count == 6, let value = UInt64(hex, radix: 16) else {
    throw AppIconRasterError.malformed("color \(source)")
  }
  return (
    CGFloat((value >> 16) & 0xff) / 255,
    CGFloat((value >> 8) & 0xff) / 255,
    CGFloat(value & 0xff) / 255
  )
}

func polygonPoints(_ commands: String) throws -> [CGPoint] {
  let invalid = commands.replacingOccurrences(
    of: #"[MLZmlz0-9.,\s-]"#,
    with: "",
    options: .regularExpression
  )
  guard invalid.isEmpty else {
    throw AppIconRasterError.malformed("unsupported path command")
  }
  let normalized = commands.replacingOccurrences(
    of: #"[MLZmlz,]"#,
    with: " ",
    options: .regularExpression
  )
  let values = try normalized.split(whereSeparator: \Character.isWhitespace).map { token in
    guard let value = Double(token) else {
      throw AppIconRasterError.malformed("path coordinate \(token)")
    }
    return value
  }
  guard values.count >= 6, values.count.isMultiple(of: 2) else {
    throw AppIconRasterError.malformed("path coordinate count")
  }
  return stride(from: 0, to: values.count, by: 2).map {
    CGPoint(x: values[$0], y: values[$0 + 1])
  }
}

func rasterize(sourcePath: String, outputPath: String) throws {
  let svg = try String(contentsOfFile: sourcePath, encoding: .utf8)
  guard svg.contains(#"viewBox="0 0 1024 1024""#) else {
    throw AppIconRasterError.malformed("viewBox")
  }
  let rectangles = try captures(#"<rect[^>]*fill="([^"]+)""#, in: svg)
  let paths = try captures(#"<path\s+d="([^"]+)"\s+fill="([^"]+)"\s*/>"#, in: svg)
  guard rectangles.count == 1, rectangles[0].count == 1, paths.count == 4 else {
    throw AppIconRasterError.malformed("expected one background and four glyph paths")
  }

  let width = 1024
  let height = 1024
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue
    | CGImageAlphaInfo.noneSkipLast.rawValue
  guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo
  ) else {
    throw AppIconRasterError.cannotCreateContext
  }

  let background = try colorComponents(rectangles[0][0])
  context.setFillColor(red: background.0, green: background.1, blue: background.2, alpha: 1)
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.translateBy(x: 0, y: CGFloat(height))
  context.scaleBy(x: 1, y: -1)

  for path in paths {
    let points = try polygonPoints(path[0])
    let fill = try colorComponents(path[1])
    context.beginPath()
    context.move(to: points[0])
    points.dropFirst().forEach { context.addLine(to: $0) }
    context.closePath()
    context.setFillColor(red: fill.0, green: fill.1, blue: fill.2, alpha: 1)
    context.fillPath()
  }

  guard let image = context.makeImage() else {
    throw AppIconRasterError.cannotCreateImage
  }
  let outputURL = URL(fileURLWithPath: outputPath) as CFURL
  guard let destination = CGImageDestinationCreateWithURL(
    outputURL,
    UTType.png.identifier as CFString,
    1,
    nil
  ) else {
    throw AppIconRasterError.cannotWrite
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw AppIconRasterError.cannotWrite
  }
}

do {
  guard CommandLine.arguments.count == 3 else { throw AppIconRasterError.usage }
  try rasterize(
    sourcePath: CommandLine.arguments[1],
    outputPath: CommandLine.arguments[2]
  )
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
