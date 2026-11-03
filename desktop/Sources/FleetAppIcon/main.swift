// Exports The Fleet's approved transparent ship artwork at every macOS icon size.
// Usage: fleet-app-icon <source.png> <output.iconset>
// The PNG is the single artwork source; packaging turns these exports into ICNS.
// Ethan chose this exact fleet of ships, so exports preserve its composition and alpha.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func iconError(_ message: String) -> NSError {
    NSError(domain: "fleet-app-icon", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

func loadArtwork(_ url: URL) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          CGImageSourceGetType(source) as String? == UTType.png.identifier,
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw iconError("Can't read the PNG artwork: \(url.path)")
    }
    guard image.width == image.height, image.width >= 1024 else {
        throw iconError("The artwork must be square and at least 1024 pixels wide.")
    }
    guard [.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo) else {
        throw iconError("The artwork must have an alpha channel for its transparent edges.")
    }
    return image
}

func render(_ artwork: CGImage, pixels: Int) throws -> CGImage {
    guard let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw iconError("Can't create the \(pixels)-pixel icon.")
    }
    context.interpolationQuality = .high
    context.draw(artwork, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
    guard let image = context.makeImage() else { throw iconError("Can't render the icon.") }
    return image
}

func write(_ image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw iconError("Can't write \(url.path)")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw iconError("Can't finish \(url.path)") }
}

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[2].hasSuffix(".iconset") else {
    FileHandle.standardError.write(Data("usage: fleet-app-icon <source.png> <output.iconset>\n".utf8))
    exit(64)
}
do {
    let artwork = try loadArtwork(URL(fileURLWithPath: arguments[1]))
    let output = URL(fileURLWithPath: arguments[2])
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
        try write(render(artwork, pixels: size), to: output.appendingPathComponent("icon_\(size)x\(size).png"))
        try write(render(artwork, pixels: size * 2), to: output.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
    }
} catch {
    FileHandle.standardError.write(Data("fleet-app-icon: \(error.localizedDescription)\n".utf8))
    exit(1)
}
