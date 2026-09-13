/**
 * The user-facing "what does Return do in the message composer" setting,
 * shared by the composer (which reads it on every Enter) and the settings UI
 * (which flips it). Default `false` — Return inserts a newline, Cmd/Ctrl+Return
 * sends — matching `scripts/fixtures/composer-key-contract.json`'s
 * `enter.newline` default mode.
 *
 * See `docs/plans/2026-09-13-composer-return-key-configurable-design.md`.
 */

const RETURN_KEY_SENDS_KEY = 'dash.composer.returnKeySends';

export function isReturnKeySendsEnabled(): boolean {
  try {
    return localStorage.getItem(RETURN_KEY_SENDS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setReturnKeySendsEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(RETURN_KEY_SENDS_KEY, '1');
    } else {
      localStorage.removeItem(RETURN_KEY_SENDS_KEY);
    }
  } catch {
    // A blocked localStorage just means the choice does not persist.
  }
}
