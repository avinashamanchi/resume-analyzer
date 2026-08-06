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

private final class RecognitionCancelledException: Exception {
  override var code: String { "RESUME_VISION_CANCELLED" }
  override var reason: String { "On-device text recognition was cancelled." }
}

private final class RecognitionLimitException: Exception {
  override var code: String { "RESUME_VISION_TEXT_LIMIT" }
  override var reason: String { "Recognized text exceeds the supported limit." }
}

private final class RecognitionTimeoutException: Exception {
  override var code: String { "RESUME_VISION_TIMEOUT" }
  override var reason: String { "On-device text recognition timed out." }
}

private struct ResumeVisionExtractionResult: Sendable {
  let text: String
  let pageCount: Int
}

private final class ResumeVisionOperation: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var timedOut = false
  private weak var activeRequest: VNRequest?

  func cancel() {
    let request: VNRequest?
    lock.lock()
    cancelled = true
    request = activeRequest
    lock.unlock()
    request?.cancel()
  }

  func cancelForDeadline() {
    let request: VNRequest?
    lock.lock()
    timedOut = true
    request = activeRequest
    lock.unlock()
    request?.cancel()
  }

  func register(_ request: VNRequest) -> Bool {
    lock.lock()
    let permitted = !cancelled && !timedOut
    if permitted { activeRequest = request }
    lock.unlock()
    if !permitted { request.cancel() }
    return permitted
  }

  func clear(_ request: VNRequest) {
    lock.lock()
    if activeRequest === request { activeRequest = nil }
    lock.unlock()
  }

  var wasCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  var didTimeOut: Bool {
    lock.lock()
    defer { lock.unlock() }
    return timedOut
  }
}

private final class ResumeVisionOperationRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var operations: [String: ResumeVisionOperation] = [:]
  private var pendingCancellations: [String] = []
  private let maximumPendingCancellations = 32

  func begin(_ operationId: String) throws -> ResumeVisionOperation {
    lock.lock()
    defer { lock.unlock() }
    guard operations[operationId] == nil else { throw RecognitionFailedException() }
    if let pendingIndex = pendingCancellations.firstIndex(of: operationId) {
      pendingCancellations.remove(at: pendingIndex)
      throw RecognitionCancelledException()
    }
    let operation = ResumeVisionOperation()
    operations[operationId] = operation
    return operation
  }

  func cancel(_ operationId: String) {
    lock.lock()
    let operation = operations[operationId]
    if operation == nil && !pendingCancellations.contains(operationId) {
      if pendingCancellations.count == maximumPendingCancellations {
        pendingCancellations.removeFirst()
      }
      pendingCancellations.append(operationId)
    }
    lock.unlock()
    operation?.cancel()
  }

  func finish(_ operationId: String, operation: ResumeVisionOperation) {
    lock.lock()
    if operations[operationId] === operation { operations.removeValue(forKey: operationId) }
    lock.unlock()
  }
}

public final class ResumeVisionModule: Module {
  private static let maximumPdfBytes = 10 * 1024 * 1024
  private static let maximumPages = 10
  private static let maximumTextScalars = 30_000
  private static let maximumImageDimension: CGFloat = 1_800
  private static let operationDeadlineNanoseconds: UInt64 = 30_000_000_000
  private let operations = ResumeVisionOperationRegistry()

  public func definition() -> ModuleDefinition {
    Name("ResumeVision")

    AsyncFunction("extractTextFromPdf") {
      (uri: String, operationId: String) async throws -> [String: Any] in
      let deadline = ResumeVisionSoftDeadline(
        startedAtNanoseconds: DispatchTime.now().uptimeNanoseconds,
        durationNanoseconds: Self.operationDeadlineNanoseconds
      )
      guard Self.canonicalUuid(operationId) else { throw RecognitionFailedException() }
      let operation = try self.operations.begin(operationId)
      defer { self.operations.finish(operationId, operation: operation) }

      let result = try await Task.detached(priority: .userInitiated) {
        try Self.extract(uri: uri, operation: operation, deadline: deadline)
      }.value
      return ["text": result.text, "pageCount": result.pageCount]
    }

    AsyncFunction("cancelExtraction") { (operationId: String) in
      guard Self.canonicalUuid(operationId) else { return }
      self.operations.cancel(operationId)
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

  private static func extract(
    uri: String,
    operation: ResumeVisionOperation,
    deadline: ResumeVisionSoftDeadline
  ) throws -> ResumeVisionExtractionResult {
    try check(operation, deadline)
    let url = try validatedLocalPdfUrl(uri)
    try check(operation, deadline)
    let validated = try validatedDocument(url, operation: operation, deadline: deadline)
    try check(operation, deadline)
    let text = try recognize(
      validated.document,
      pageCount: validated.pageCount,
      operation: operation,
      deadline: deadline
    )
    try check(operation, deadline)
    return ResumeVisionExtractionResult(text: text, pageCount: validated.pageCount)
  }

  private static func check(
    _ operation: ResumeVisionOperation,
    _ deadline: ResumeVisionSoftDeadline
  ) throws {
    if deadline.hasExpired(atNanoseconds: DispatchTime.now().uptimeNanoseconds) {
      operation.cancelForDeadline()
      throw RecognitionTimeoutException()
    }
    if operation.didTimeOut { throw RecognitionTimeoutException() }
    if operation.wasCancelled || Task.isCancelled { throw RecognitionCancelledException() }
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

  private static func validatedDocument(
    _ url: URL,
    operation: ResumeVisionOperation,
    deadline: ResumeVisionSoftDeadline
  ) throws -> (document: PDFDocument, pageCount: Int) {
    try check(operation, deadline)
    guard let document = PDFDocument(url: url) else {
      throw InvalidLocalPdfException()
    }
    try check(operation, deadline)
    let isEncrypted = document.isEncrypted
    try check(operation, deadline)
    let isLocked = document.isLocked
    try check(operation, deadline)
    if isEncrypted || isLocked { throw EncryptedPdfException() }
    let pageCount = document.pageCount
    try check(operation, deadline)
    guard pageCount > 0 else { throw InvalidLocalPdfException() }
    guard pageCount <= maximumPages else { throw PdfPageLimitException() }
    return (document, pageCount)
  }

  private static func recognize(
    _ document: PDFDocument,
    pageCount: Int,
    operation: ResumeVisionOperation,
    deadline: ResumeVisionSoftDeadline
  ) throws -> String {
    var pages: [String] = []
    var scalarCount = 0
    pages.reserveCapacity(pageCount)

    for pageIndex in 0..<pageCount {
      try check(operation, deadline)
      guard let page = document.page(at: pageIndex) else {
        throw InvalidLocalPdfException()
      }
      try check(operation, deadline)

      let pageText = try autoreleasepool {
        try recognizePage(page, operation: operation, deadline: deadline)
      }
      try check(operation, deadline)

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

  private static func recognizePage(
    _ page: PDFPage,
    operation: ResumeVisionOperation,
    deadline: ResumeVisionSoftDeadline
  ) throws -> String {
    try check(operation, deadline)
    let bounds = page.bounds(for: .mediaBox)
    try check(operation, deadline)
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
    try check(operation, deadline)
    let image = page.thumbnail(of: target, for: .mediaBox)
    try check(operation, deadline)
    guard let cgImage = image.cgImage else { throw RecognitionFailedException() }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    guard operation.register(request) else {
      try check(operation, deadline)
      throw RecognitionCancelledException()
    }
    let remaining = deadline.remainingNanoseconds(
      atNanoseconds: DispatchTime.now().uptimeNanoseconds
    )
    guard remaining > 0 else {
      operation.cancelForDeadline()
      throw RecognitionTimeoutException()
    }
    let cancellation = DispatchWorkItem { operation.cancelForDeadline() }
    DispatchQueue.global(qos: .userInitiated).asyncAfter(
      deadline: .now() + .nanoseconds(Int(remaining)),
      execute: cancellation
    )
    defer {
      cancellation.cancel()
      operation.clear(request)
    }

    do {
      try check(operation, deadline)
      try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
      try check(operation, deadline)
    } catch is RecognitionTimeoutException {
      throw RecognitionTimeoutException()
    } catch is RecognitionCancelledException {
      throw RecognitionCancelledException()
    } catch {
      if operation.didTimeOut || deadline.hasExpired(
        atNanoseconds: DispatchTime.now().uptimeNanoseconds
      ) {
        throw RecognitionTimeoutException()
      }
      if operation.wasCancelled || Task.isCancelled {
        throw RecognitionCancelledException()
      }
      throw RecognitionFailedException()
    }

    let results = request.results ?? []
    let geometries = results.enumerated().map { index, observation in
      ResumeVisionObservationGeometry(
        originalIndex: index,
        minX: Double(observation.boundingBox.minX),
        minY: Double(observation.boundingBox.minY),
        maxX: Double(observation.boundingBox.maxX),
        maxY: Double(observation.boundingBox.maxY)
      )
    }
    let ordered = ResumeVisionReadingOrder.ordered(geometries)
    try check(operation, deadline)
    let lines = ordered.compactMap { geometry in
      results[geometry.originalIndex].topCandidates(1).first?.string
    }
    try check(operation, deadline)
    return lines.joined(separator: "\n")
  }
}
