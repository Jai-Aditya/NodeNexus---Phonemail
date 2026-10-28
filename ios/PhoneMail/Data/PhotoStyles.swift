import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Styles for a profile photo, applied on the phone before upload, so only the stylised picture leaves it.
/// Same definitions on every PhoneMail client; all work on the 512 x 512 square crop.
enum PhotoStyle: String, CaseIterable, Identifiable {
    case original, oil, pixel, outline, pencil

    var id: String { rawValue }

    var title: String {
        switch self {
        case .original: L("Original")
        case .oil: L("Oil painting")
        case .pixel: L("Pixel")
        case .outline: L("Outline")
        case .pencil: L("Pencil sketch")
        }
    }

    static let side = 512

    /// The styled picture (512 x 512). Slow styles take a fraction of a second: call off the main thread.
    func apply(to image: CGImage) -> CGImage {
        let px = Pixels(image, side: Self.side)
        switch self {
        case .original: return px.image()
        case .pixel: return Self.pixelate(px, cells: 20).image()
        case .oil: return Self.oil(image)
        case .outline: return Self.outline(px).image()
        case .pencil: return Self.pencil(px.image())
        }
    }

    // Pixel: a 20 x 20 grid, each cell filled with its average colour.
    static func pixelate(_ src: Pixels, cells: Int) -> Pixels {
        var out = src
        let n = src.side
        for cy in 0..<cells {
            let y0 = cy * n / cells, y1 = (cy + 1) * n / cells
            for cx in 0..<cells {
                let x0 = cx * n / cells, x1 = (cx + 1) * n / cells
                var r = 0, g = 0, b = 0
                for y in y0..<y1 { for x in x0..<x1 { let i = (y * n + x) * 4; r += Int(src.data[i]); g += Int(src.data[i + 1]); b += Int(src.data[i + 2]) } }
                let count = (y1 - y0) * (x1 - x0)
                let (ar, ag, ab) = (UInt8(r / count), UInt8(g / count), UInt8(b / count))
                for y in y0..<y1 { for x in x0..<x1 { let i = (y * n + x) * 4; out.data[i] = ar; out.data[i + 1] = ag; out.data[i + 2] = ab; out.data[i + 3] = 255 } }
            }
        }
        return out
    }

    // Oil painting: on a 256 x 256 copy, each pixel takes the average colour of the most common intensity
    // band (20 bands) among its neighbours within 4 pixels; then scaled back to 512, smoothed.
    static func oil(_ image: CGImage, radius: Int = 4, levels: Int = 20) -> CGImage {
        let src = Pixels(image, side: 256)
        var out = src
        let n = src.side
        var count = [Int](repeating: 0, count: levels), sr = count, sg = count, sb = count
        var band = [Int](repeating: 0, count: n * n)
        for p in 0..<(n * n) {
            let i = p * 4
            band[p] = min(levels - 1, (Int(src.data[i]) + Int(src.data[i + 1]) + Int(src.data[i + 2])) / 3 * levels / 256)
        }
        for y in 0..<n {
            for x in 0..<n {
                for k in 0..<levels { count[k] = 0; sr[k] = 0; sg[k] = 0; sb[k] = 0 }
                for yy in max(0, y - radius)...min(n - 1, y + radius) {
                    for xx in max(0, x - radius)...min(n - 1, x + radius) {
                        let p = yy * n + xx, i = p * 4, k = band[p]
                        count[k] += 1; sr[k] += Int(src.data[i]); sg[k] += Int(src.data[i + 1]); sb[k] += Int(src.data[i + 2])
                    }
                }
                var best = 0
                for k in 1..<levels where count[k] > count[best] { best = k }
                let i = (y * n + x) * 4
                out.data[i] = UInt8(sr[best] / count[best]); out.data[i + 1] = UInt8(sg[best] / count[best])
                out.data[i + 2] = UInt8(sb[best] / count[best]); out.data[i + 3] = 255
            }
        }
        return Pixels(out.image(), side: side).image() // Pixels scales with high-quality interpolation
    }

    // Outline: grayscale, Sobel edges, dark lines (#1b1b1b, about 2 px) on white (#fafafa).
    static func outline(_ src: Pixels, threshold: Double = 90) -> Pixels {
        let n = src.side
        var gray = [Double](repeating: 0, count: n * n)
        for p in 0..<(n * n) {
            let i = p * 4
            gray[p] = 0.299 * Double(src.data[i]) + 0.587 * Double(src.data[i + 1]) + 0.114 * Double(src.data[i + 2])
        }
        var edge = [Bool](repeating: false, count: n * n)
        for y in 1..<(n - 1) {
            for x in 1..<(n - 1) {
                func g(_ dx: Int, _ dy: Int) -> Double { gray[(y + dy) * n + x + dx] }
                let gx = -g(-1, -1) - 2 * g(-1, 0) - g(-1, 1) + g(1, -1) + 2 * g(1, 0) + g(1, 1)
                let gy = -g(-1, -1) - 2 * g(0, -1) - g(1, -1) + g(-1, 1) + 2 * g(0, 1) + g(1, 1)
                edge[y * n + x] = (gx * gx + gy * gy).squareRoot() > threshold
            }
        }
        var out = src
        for y in 0..<n {
            for x in 0..<n {
                // Thicken to ~2 px: a pixel is a line if it or a right/lower neighbour is an edge.
                let on = edge[y * n + x] || (x + 1 < n && edge[y * n + x + 1]) || (y + 1 < n && edge[(y + 1) * n + x])
                let v: UInt8 = on ? 0x1b : 0xfa
                let i = (y * n + x) * 4
                out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255
            }
        }
        return out
    }

    // Pencil sketch: grayscale, inverted and blurred, colour-dodged over the grayscale, a little more contrast.
    static func pencil(_ image: CGImage) -> CGImage {
        let input = CIImage(cgImage: image)
        let gray = CIFilter.colorControls()
        gray.inputImage = input
        gray.saturation = 0
        guard let g = gray.outputImage else { return image }
        let invert = CIFilter.colorInvert()
        invert.inputImage = g
        let blur = CIFilter.gaussianBlur()
        blur.inputImage = invert.outputImage?.clampedToExtent()
        blur.radius = 8
        let dodge = CIFilter.colorDodgeBlendMode()
        dodge.inputImage = blur.outputImage?.cropped(to: input.extent)
        dodge.backgroundImage = g
        let contrast = CIFilter.colorControls()
        contrast.inputImage = dodge.outputImage
        contrast.contrast = 1.15
        guard let out = contrast.outputImage?.cropped(to: input.extent),
              let cg = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!]).createCGImage(out, from: input.extent)
        else { return image }
        return Pixels(cg, side: side).image()
    }
}

/// An RGBA8 copy of an image, scaled to side x side.
struct Pixels {
    let side: Int
    var data: [UInt8]

    init(_ image: CGImage, side: Int) {
        self.side = side
        data = [UInt8](repeating: 0, count: side * side * 4)
        data.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.interpolationQuality = .high
            ctx.setFillColor(UIColor.white.cgColor)
            ctx.fill(CGRect(x: 0, y: 0, width: side, height: side))
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        }
    }

    func image() -> CGImage {
        var copy = data
        return copy.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
        }
    }
}

extension AvatarPhoto {
    /// The centred square crop at 512 x 512, ready for a style.
    static func square(_ data: Data, side: CGFloat = 512) -> CGImage? {
        guard let img = UIImage(data: data) else { return nil }
        let w = img.size.width, h = img.size.height
        let s = min(w, h)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let out = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            let scale = side / s
            img.draw(in: CGRect(x: -(w - s) / 2 * scale, y: -(h - s) / 2 * scale, width: w * scale, height: h * scale))
        }
        return out.cgImage
    }

    static func jpeg(_ image: CGImage) -> Data? { UIImage(cgImage: image).jpegData(compressionQuality: 0.85) }
}
