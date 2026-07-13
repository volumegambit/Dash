enum SequenceDecision: Equatable, Sendable {
  case duplicate
  case contiguous
  case gap(sinceSeq: Int, pendingSeq: Int)
}

struct SequenceReconciler: Sendable {
  private(set) var lastAppliedSeq: Int

  mutating func accept(seq: Int) -> SequenceDecision {
    guard seq > lastAppliedSeq else { return .duplicate }
    guard seq == lastAppliedSeq + 1 else {
      return .gap(sinceSeq: lastAppliedSeq, pendingSeq: seq)
    }
    lastAppliedSeq = seq
    return .contiguous
  }
}
