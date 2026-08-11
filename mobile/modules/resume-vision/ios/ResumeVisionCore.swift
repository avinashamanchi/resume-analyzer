enum ResumeVisionEmbeddedText {
  static func usable(_ value: String?) -> String? {
    guard let value,
          !value.unicodeScalars.contains(where: { $0.value == 0 }),
          value.unicodeScalars.contains(where: { !$0.properties.isWhitespace }) else {
      return nil
    }
    return value
  }
}

struct ResumeVisionObservationGeometry: Equatable, Sendable {
  let originalIndex: Int
  let minX: Double
  let minY: Double
  let maxX: Double
  let maxY: Double

  var height: Double { maxY - minY }
}

enum ResumeVisionReadingOrder {
  private struct Row {
    let anchor: ResumeVisionObservationGeometry
    var observations: [ResumeVisionObservationGeometry]
  }

  static func ordered(
    _ observations: [ResumeVisionObservationGeometry]
  ) -> [ResumeVisionObservationGeometry] {
    let seeded = observations.sorted(by: topToBottomSeed)
    var rows: [Row] = []

    for observation in seeded {
      if let rowIndex = rows.firstIndex(where: { belongsToSameRow(observation, $0.anchor) }) {
        rows[rowIndex].observations.append(observation)
      } else {
        rows.append(Row(anchor: observation, observations: [observation]))
      }
    }

    return rows
      .sorted { topToBottomSeed($0.anchor, $1.anchor) }
      .flatMap { row in
        row.observations.sorted { left, right in
          let leftX = sortable(left.minX)
          let rightX = sortable(right.minX)
          if leftX != rightX { return leftX < rightX }
          return left.originalIndex < right.originalIndex
        }
      }
  }

  private static func topToBottomSeed(
    _ left: ResumeVisionObservationGeometry,
    _ right: ResumeVisionObservationGeometry
  ) -> Bool {
    let leftMaxY = sortable(left.maxY)
    let rightMaxY = sortable(right.maxY)
    if leftMaxY != rightMaxY { return leftMaxY > rightMaxY }
    let leftMinY = sortable(left.minY)
    let rightMinY = sortable(right.minY)
    if leftMinY != rightMinY { return leftMinY > rightMinY }
    let leftMinX = sortable(left.minX)
    let rightMinX = sortable(right.minX)
    if leftMinX != rightMinX { return leftMinX < rightMinX }
    return left.originalIndex < right.originalIndex
  }

  private static func belongsToSameRow(
    _ candidate: ResumeVisionObservationGeometry,
    _ anchor: ResumeVisionObservationGeometry
  ) -> Bool {
    let candidateMinY = sortable(candidate.minY)
    let candidateMaxY = sortable(candidate.maxY)
    let anchorMinY = sortable(anchor.minY)
    let anchorMaxY = sortable(anchor.maxY)
    let candidateHeight = candidateMaxY - candidateMinY
    let anchorHeight = anchorMaxY - anchorMinY
    guard candidateHeight > 0, anchorHeight > 0 else { return false }
    let overlap = min(candidateMaxY, anchorMaxY) - max(candidateMinY, anchorMinY)
    guard overlap > 0 else { return false }
    let overlapRatio = overlap / min(candidateHeight, anchorHeight)
    let baselineDelta = abs(candidateMinY - anchorMinY)
    let baselineAllowance = max(0.002, min(candidateHeight, anchorHeight) * 0.5)
    return overlapRatio >= 0.5 && baselineDelta <= baselineAllowance
  }

  private static func sortable(_ value: Double) -> Double {
    value.isFinite ? value : 0
  }
}

struct ResumeVisionSoftDeadline: Equatable, Sendable {
  private let cutoffNanoseconds: UInt64

  init(startedAtNanoseconds: UInt64, durationNanoseconds: UInt64) {
    if durationNanoseconds > UInt64.max - startedAtNanoseconds {
      cutoffNanoseconds = UInt64.max
    } else {
      cutoffNanoseconds = startedAtNanoseconds + durationNanoseconds
    }
  }

  func hasExpired(atNanoseconds now: UInt64) -> Bool {
    now >= cutoffNanoseconds
  }

  func remainingNanoseconds(atNanoseconds now: UInt64) -> UInt64 {
    now >= cutoffNanoseconds ? 0 : cutoffNanoseconds - now
  }
}
