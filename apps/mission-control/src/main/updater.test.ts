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

  it('does not crash when checkForUpdatesAndNotify rejects', async () => {
    const fakeUpdater = {
      checkForUpdatesAndNotify: vi.fn().mockRejectedValue(new Error('No published versions')),
      autoDownload: false,
      autoInstallOnAppQuit: false,
    };

    await expect(setupAutoUpdater(fakeUpdater as never, true)).resolves.toBeUndefined();
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
