private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    fatalError(message)
  }
}

private func orderedIndices(
  _ observations: [ResumeVisionObservationGeometry]
) -> [Int] {
  ResumeVisionReadingOrder.ordered(observations).map(\.originalIndex)
}

let adjacentLines = [
  ResumeVisionObservationGeometry(
    originalIndex: 0,
    minX: 0.10,
    minY: 0.800,
    maxX: 0.60,
    maxY: 0.820
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 1,
    minX: 0.10,
    minY: 0.783,
    maxX: 0.60,
    maxY: 0.803
  ),
]
require(
  orderedIndices(adjacentLines) == [0, 1],
  "Adjacent same-X lines must remain top-to-bottom instead of being merged by midpoint tolerance."
)

let twoColumns = [
  ResumeVisionObservationGeometry(
    originalIndex: 3,
    minX: 0.58,
    minY: 0.68,
    maxX: 0.92,
    maxY: 0.72
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 0,
    minX: 0.08,
    minY: 0.80,
    maxX: 0.42,
    maxY: 0.84
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 2,
    minX: 0.08,
    minY: 0.68,
    maxX: 0.42,
    maxY: 0.72
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 1,
    minX: 0.58,
    minY: 0.80,
    maxX: 0.92,
    maxY: 0.84
  ),
]
require(
  orderedIndices(twoColumns) == [0, 1, 2, 3],
  "Rows must be top-to-bottom and row items left-to-right."
)

let equalBoxes = [
  ResumeVisionObservationGeometry(
    originalIndex: 7,
    minX: 0.2,
    minY: 0.4,
    maxX: 0.6,
    maxY: 0.5
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 4,
    minX: 0.2,
    minY: 0.4,
    maxX: 0.6,
    maxY: 0.5
  ),
]
require(
  orderedIndices(equalBoxes) == [4, 7],
  "Equal geometry must use the stable original index, never a recognition UUID."
)

let cycleRegression = [
  ResumeVisionObservationGeometry(
    originalIndex: 0,
    minX: 0.70,
    minY: 0.790,
    maxX: 0.90,
    maxY: 0.810
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 1,
    minX: 0.10,
    minY: 0.775,
    maxX: 0.30,
    maxY: 0.795
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 2,
    minX: 0.40,
    minY: 0.760,
    maxX: 0.60,
    maxY: 0.780
  ),
]
let canonicalCycleOrder = orderedIndices(cycleRegression)
require(
  canonicalCycleOrder == orderedIndices([cycleRegression[2], cycleRegression[0], cycleRegression[1]]),
  "Ordering must be independent of Vision result-array iteration once original indices are captured."
)
let ranks = Dictionary(uniqueKeysWithValues: canonicalCycleOrder.enumerated().map { ($0.element, $0.offset) })
for first in canonicalCycleOrder {
  for second in canonicalCycleOrder where ranks[first]! < ranks[second]! {
    for third in canonicalCycleOrder where ranks[second]! < ranks[third]! {
      require(ranks[first]! < ranks[third]!, "Reading order must be transitive.")
    }
  }
}

let nonFiniteRegression = [
  ResumeVisionObservationGeometry(
    originalIndex: 0,
    minX: Double.nan,
    minY: 0.5,
    maxX: Double.infinity,
    maxY: Double.nan
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 1,
    minX: 0.2,
    minY: 0.5,
    maxX: 0.4,
    maxY: 0.6
  ),
  ResumeVisionObservationGeometry(
    originalIndex: 2,
    minX: 0.2,
    minY: 0.4,
    maxX: 0.4,
    maxY: 0.5
  ),
]
require(
  orderedIndices(nonFiniteRegression) == orderedIndices(Array(nonFiniteRegression.reversed())),
  "Unexpected non-finite Vision geometry must still have deterministic original-index fallback."
)

let deadline = ResumeVisionSoftDeadline(
  startedAtNanoseconds: 1_000,
  durationNanoseconds: 30
)
require(!deadline.hasExpired(atNanoseconds: 1_029), "Deadline expired early.")
require(deadline.remainingNanoseconds(atNanoseconds: 1_029) == 1, "Remaining time is not monotonic.")
require(deadline.hasExpired(atNanoseconds: 1_030), "Deadline must expire at its boundary.")
require(deadline.remainingNanoseconds(atNanoseconds: 1_030) == 0, "Expired deadline retained time.")
require(deadline.hasExpired(atNanoseconds: 1_100), "Expired deadline revived.")

print("ResumeVision native core invariants passed")
