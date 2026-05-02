import AppKit
import Foundation
import PDFKit
import Vision

func jsonOut(_ text: String, pageCount: Int = 0, source: String = "") {
    let payload: [String: Any] = [
        "text": text,
        "pageCount": pageCount,
        "source": source
    ]
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
    FileHandle.standardOutput.write(data)
}

func normalize(_ text: String) -> String {
    return text
        .components(separatedBy: .newlines)
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
}

func recognizeText(from cgImage: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US", "zh-Hans"]
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return normalize(lines.joined(separator: "\n"))
}

func cgImage(from path: String) -> CGImage? {
    guard let image = NSImage(contentsOfFile: path) else { return nil }
    var rect = CGRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func render(page: PDFPage, maxDimension: CGFloat = 2400) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    if bounds.width <= 0 || bounds.height <= 0 { return nil }
    let scale = min(maxDimension / max(bounds.width, bounds.height), 3.0)
    let width = max(1, Int(bounds.width * scale))
    let height = max(1, Int(bounds.height * scale))
    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.saveGState()
    ctx.translateBy(x: 0, y: CGFloat(height))
    ctx.scaleBy(x: scale, y: -scale)
    page.draw(with: .mediaBox, to: ctx)
    ctx.restoreGState()
    return ctx.makeImage()
}

func extractPdfText(path: String, maxPages: Int) throws -> (String, Int, String) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
        throw NSError(domain: "windsurfapi.ocr", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to open PDF"])
    }
    let pageCount = doc.pageCount
    let rawText = (0..<pageCount).compactMap { doc.page(at: $0)?.string }.joined(separator: "\n")
    let pdfText = normalize(rawText)
    if !pdfText.isEmpty {
        return (pdfText, pageCount, "pdfkit")
    }

    let limit = max(1, min(pageCount, maxPages))
    var ocrParts: [String] = []
    for idx in 0..<limit {
        guard let page = doc.page(at: idx), let image = render(page: page) else { continue }
        let text = try recognizeText(from: image)
        if !text.isEmpty { ocrParts.append(text) }
    }
    return (normalize(ocrParts.joined(separator: "\n")), pageCount, "vision")
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    jsonOut("")
    exit(0)
}

let inputPath = args[1]
let mode = args[2]
let maxPages = args.count >= 4 ? max(1, Int(args[3]) ?? 3) : 3

do {
    if mode == "pdf" {
        let result = try extractPdfText(path: inputPath, maxPages: maxPages)
        jsonOut(result.0, pageCount: result.1, source: result.2)
    } else {
        guard let image = cgImage(from: inputPath) else {
            throw NSError(domain: "windsurfapi.ocr", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to load image"])
        }
        let text = try recognizeText(from: image)
        jsonOut(text, pageCount: 1, source: "vision")
    }
} catch {
    jsonOut("")
}
