import AppKit
import Foundation

// Draw a code-native icon, then produce the standard macOS iconset sizes.
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
let background = NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 196, yRadius: 196)
NSGradient(starting: NSColor(red: 0.88, green: 0.92, blue: 0.85, alpha: 1), ending: NSColor(red: 0.71, green: 0.80, blue: 0.67, alpha: 1))!.draw(in: background, angle: -70)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.13)
shadow.shadowBlurRadius = 26
shadow.shadowOffset = NSSize(width: 0, height: -12)
NSGraphicsContext.saveGraphicsState()
shadow.set()
let cover = NSBezierPath(roundedRect: NSRect(x: 278, y: 211, width: 482, height: 608), xRadius: 32, yRadius: 32)
NSColor(red: 0.20, green: 0.37, blue: 0.28, alpha: 1).setFill()
cover.fill()
NSGraphicsContext.restoreGraphicsState()
NSColor(red: 0.93, green: 0.95, blue: 0.86, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 300, y: 219, width: 441, height: 46), xRadius: 11, yRadius: 11).fill()
NSColor(red: 0.27, green: 0.45, blue: 0.34, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 322, y: 270, width: 3, height: 540)).fill()
let book = NSBezierPath()
book.move(to: NSPoint(x: 417, y: 535))
book.curve(to: NSPoint(x: 529, y: 522), controlPoint1: NSPoint(x: 450, y: 549), controlPoint2: NSPoint(x: 495, y: 541))
book.curve(to: NSPoint(x: 641, y: 535), controlPoint1: NSPoint(x: 565, y: 541), controlPoint2: NSPoint(x: 605, y: 549))
book.line(to: NSPoint(x: 641, y: 674))
book.curve(to: NSPoint(x: 529, y: 660), controlPoint1: NSPoint(x: 605, y: 688), controlPoint2: NSPoint(x: 563, y: 678))
book.curve(to: NSPoint(x: 417, y: 674), controlPoint1: NSPoint(x: 491, y: 678), controlPoint2: NSPoint(x: 452, y: 688))
book.close()
book.lineWidth = 10
book.lineJoinStyle = .round
NSColor(red: 0.88, green: 0.93, blue: 0.81, alpha: 1).setStroke()
book.stroke()
let crease = NSBezierPath()
crease.move(to: NSPoint(x: 529, y: 660)); crease.line(to: NSPoint(x: 529, y: 522)); crease.lineWidth = 8; crease.stroke()
let line = NSBezierPath(roundedRect: NSRect(x: 447, y: 398, width: 165, height: 6), xRadius: 3, yRadius: 3)
NSColor(red: 0.68, green: 0.79, blue: 0.60, alpha: 1).setFill(); line.fill()
image.unlockFocus()
for size in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = size * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    NSGraphicsContext.restoreGraphicsState()
    let suffix = scale == 2 ? "@2x" : ""
    try bitmap.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
  }
}
