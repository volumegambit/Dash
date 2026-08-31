import Testing

@testable import Dash

@Suite("Sequence reconciliation")
struct SequenceReconcilerTests {
  @Test("sequence gap requests replay from the durable cursor")
  func gap() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 4)

    #expect(reconciler.accept(seq: 6) == .gap(sinceSeq: 4, pendingSeq: 6))
    #expect(reconciler.lastAppliedSeq == 4)
  }

  @Test("a duplicate sequence is ignored without moving the cursor")
  func duplicate() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 4)

    #expect(reconciler.accept(seq: 4) == .duplicate)
    #expect(reconciler.accept(seq: 3) == .duplicate)
    #expect(reconciler.lastAppliedSeq == 4)
  }

  @Test("a contiguous sequence advances the cursor")
  func contiguous() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 4)

    #expect(reconciler.accept(seq: 5) == .contiguous)
    #expect(reconciler.lastAppliedSeq == 5)
  }

  @Test("replay can fill a gap before the pending live sequence is accepted")
  func replayFillsGap() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 4)

    #expect(reconciler.accept(seq: 6) == .gap(sinceSeq: 4, pendingSeq: 6))
    #expect(reconciler.accept(seq: 5) == .contiguous)
    #expect(reconciler.accept(seq: 6) == .contiguous)
    #expect(reconciler.lastAppliedSeq == 6)
  }

  @Test("a terminal sequence remains ordered and duplicate terminal delivery is ignored")
  func terminalOrdering() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 10)

    #expect(reconciler.accept(seq: 11) == .contiguous)
    #expect(reconciler.accept(seq: 12) == .contiguous)
    #expect(reconciler.accept(seq: 12) == .duplicate)
    #expect(reconciler.lastAppliedSeq == 12)
  }

  @Test("the durable cursor never regresses")
  func cursorMonotonicity() {
    var reconciler = SequenceReconciler(lastAppliedSeq: 9)

    #expect(reconciler.accept(seq: 7) == .duplicate)
    #expect(reconciler.accept(seq: 9) == .duplicate)
    #expect(reconciler.accept(seq: 10) == .contiguous)
    #expect(reconciler.lastAppliedSeq == 10)
  }
}
