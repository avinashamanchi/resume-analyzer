import ExpoModulesCore
import Foundation
import PDFKit
import UIKit
import Vision

private final class InvalidLocalPdfException: Exception {
  override var code: String { "RESUME_VISION_INVALID_PDF" }
  override var reason: String { "The selected PDF is not available for private text recognition." }
}

private final class EncryptedPdfException: Exception {
  override var code: String { "RESUME_VISION_ENCRYPTED_PDF" }
  override var reason: String { "Encrypted PDFs are not supported." }
}

private final class PdfPageLimitException: Exception {
  override var code: String { "RESUME_VISION_PAGE_LIMIT" }
  override var reason: String { "The selected PDF exceeds the page limit." }
}

private final class RecognitionFailedException: Exception {
  override var code: String { "RESUME_VISION_RECOGNITION_FAILED" }
  override var reason: String { "On-device text recognition could not finish." }
}

private final class RecognitionLimitException: Exception {
  override var code: String { "RESUME_VISION_TEXT_LIMIT" }
  override var reason: String { "Recognized text exceeds the supported limit." }
}

private final class RecognitionTimeoutException: Exception {
  override var code: String { "RESUME_VISION_TIMEOUT" }
  override var reason: String { "On-device text recognition timed out." }
}

public final class ResumeVisionModule: Module {
  private static let maximumPdfBytes = 10 * 1024 * 1024
  private static let maximumPages = 10
  private static let maximumTextScalars = 30_000
  private static let maximumImageDimension: CGFloat = 1_800
  private static let operationDeadline: TimeInterval = 30
  private static let sameLineTolerance: CGFloat = 0.018

  public func definition() -> ModuleDefinition {
    Name("ResumeVision")

    AsyncFunction("extractTextFromPdf") { (uri: String) async throws -> [String: Any] in
      let url = try Self.validatedLocalPdfUrl(uri)
      let document = try Self.validatedDocument(url)
      let text = try Self.recognize(document)
      return ["text": text, "pageCount": document.pageCount]
    }
  }

  private static func canonicalUuid(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return value == uuid.uuidString.lowercased() &&
      value.range(
        of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#,
        options: .regularExpression
      ) != nil
  }

  private static func validatedLocalPdfUrl(_ uri: String) throws -> URL {
    guard uri.utf8.count <= 8_192,
          let url = URL(string: uri),
          url.isFileURL,
          url.host == nil || url.host == "",
          url.query == nil,
          url.fragment == nil,
          url.absoluteString.hasPrefix("file:///"),
          !url.path.contains("\0") else {
      throw InvalidLocalPdfException()
    }

    let standardized = url.standardizedFileURL
    let resolved = standardized.resolvingSymlinksInPath()
    guard url.path == standardized.path, standardized.path == resolved.path else {
      throw InvalidLocalPdfException()
    }

    guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      throw InvalidLocalPdfException()
    }
    let namespace = caches
      .appendingPathComponent("resume-ai-v1", isDirectory: true)
      .standardizedFileURL
      .resolvingSymlinksInPath()
    let requestDirectory = resolved.deletingLastPathComponent()
    guard requestDirectory.deletingLastPathComponent().path == namespace.path,
          canonicalUuid(requestDirectory.lastPathComponent),
          resolved.pathExtension == "pdf",
          canonicalUuid(resolved.deletingPathExtension().lastPathComponent) else {
      throw InvalidLocalPdfException()
    }

    let values: URLResourceValues
    do {
      values = try resolved.resourceValues(forKeys: [
        .fileSizeKey,
        .isRegularFileKey,
        .isSymbolicLinkKey,
      ])
    } catch {
      throw InvalidLocalPdfException()
    }
    guard values.isRegularFile == true,
          values.isSymbolicLink != true,
          let size = values.fileSize,
          size > 0,
          size <= maximumPdfBytes else {
      throw InvalidLocalPdfException()
    }
    return resolved
  }

  private static func validatedDocument(_ url: URL) throws -> PDFDocument {
    guard let document = PDFDocument(url: url) else {
      throw InvalidLocalPdfException()
    }
    if document.isEncrypted || document.isLocked {
      throw EncryptedPdfException()
    }
    guard document.pageCount > 0 else {
      throw InvalidLocalPdfException()
    }
    guard document.pageCount <= maximumPages else {
      throw PdfPageLimitException()
    }
    return document
  }

  private static func recognize(_ document: PDFDocument) throws -> String {
    let deadline = Date().addingTimeInterval(operationDeadline)
    var pages: [String] = []
    var scalarCount = 0
    pages.reserveCapacity(document.pageCount)

    for pageIndex in 0..<document.pageCount {
      if Task.isCancelled { throw RecognitionFailedException() }
      if Date() >= deadline { throw RecognitionTimeoutException() }
      guard let page = document.page(at: pageIndex) else {
        throw InvalidLocalPdfException()
      }

      let pageText = try autoreleasepool {
        try recognizePage(page, deadline: deadline)
      }
      if Date() >= deadline { throw RecognitionTimeoutException() }

      let addition = pageText.unicodeScalars.count + (pages.isEmpty ? 0 : 1)
      guard scalarCount + addition <= maximumTextScalars else {
        throw RecognitionLimitException()
      }
      scalarCount += addition
      pages.append(pageText)
    }

    let text = pages.joined(separator: "\n")
    guard !text.unicodeScalars.contains(where: { $0.value == 0 }),
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw RecognitionFailedException()
    }
    return text
  }

  private static func recognizePage(_ page: PDFPage, deadline: Date) throws -> String {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width.isFinite,
          bounds.height.isFinite,
          bounds.width > 0,
          bounds.height > 0 else {
      throw InvalidLocalPdfException()
    }
    let scale = min(
      maximumImageDimension / bounds.width,
      maximumImageDimension / bounds.height,
      2
    )
    let target = CGSize(
      width: max(1, floor(bounds.width * scale)),
      height: max(1, floor(bounds.height * scale))
    )
    let image = page.thumbnail(of: target, for: .mediaBox)
    guard let cgImage = image.cgImage else {
      throw RecognitionFailedException()
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let remaining = deadline.timeIntervalSinceNow
    guard remaining > 0 else {
      throw RecognitionTimeoutException()
    }
    let cancellation = DispatchWorkItem {
      request.cancel()
    }
    DispatchQueue.global(qos: .userInitiated).asyncAfter(
      deadline: .now() + remaining,
      execute: cancellation
    )
    defer { cancellation.cancel() }
    do {
      try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
    } catch {
      if Date() >= deadline {
        throw RecognitionTimeoutException()
      }
      throw RecognitionFailedException()
    }
    if Date() >= deadline {
      throw RecognitionTimeoutException()
    }

    return (request.results ?? [])
      .sorted(by: readingOrder)
      .compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: "\n")
  }

  private static func readingOrder(
    _ left: VNRecognizedTextObservation,
    _ right: VNRecognizedTextObservation
  ) -> Bool {
    let verticalDelta = left.boundingBox.midY - right.boundingBox.midY
    if abs(verticalDelta) > sameLineTolerance {
      return verticalDelta > 0
    }
    if left.boundingBox.minX != right.boundingBox.minX {
      return left.boundingBox.minX < right.boundingBox.minX
    }
    return left.uuid.uuidString < right.uuid.uuidString
  }
}
