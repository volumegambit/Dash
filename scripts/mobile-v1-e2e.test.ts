import { runMobileV1Acceptance } from './mobile-v1-e2e.mjs';

describe('mobile v1 real gateway acceptance', () => {
  it('keeps desktop-shaped and ios-shaped clients on one canonical transcript', async () => {
    const report = await runMobileV1Acceptance();

    expect(report.healthCapabilities).toEqual(['conversation-sync-v1', 'chat-resume-v1']);
    expect(report.acceptedTurnId).toBe(report.replayedTurnId);
    expect(report.desktopTranscript).toEqual(report.iosTranscript);
    expect(report.desktopTranscript.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(report.sequenceWasContiguous).toBe(true);
    expect(report.staleRenameStatus).toBe(409);
    expect(report.busyErrorCode).toBe('conversation_busy');
    expect(report.cancelOutcome).toBe('cancelled');
    expect(report.concurrentRefreshMatched).toBe(true);
    expect(report.archivedAfterAgentDelete).toBe(true);
  }, 30_000);
});
