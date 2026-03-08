import { describe, expect, it, vi } from 'vitest';
import { setupAutoUpdater } from './updater.js';

describe('setupAutoUpdater', () => {
  it('calls checkForUpdatesAndNotify when packaged', async () => {
    const fakeUpdater = {
      checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null),
      autoDownload: false,
      autoInstallOnAppQuit: false,
    };

    await setupAutoUpdater(fakeUpdater as never, true);

    expect(fakeUpdater.checkForUpdatesAndNotify).toHaveBeenCalled();
    expect(fakeUpdater.autoDownload).toBe(true);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('does NOT check when not packaged', async () => {
    const fakeUpdater = {
      checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null),
      autoDownload: false,
      autoInstallOnAppQuit: false,
    };

    await setupAutoUpdater(fakeUpdater as never, false);

    expect(fakeUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });
});
