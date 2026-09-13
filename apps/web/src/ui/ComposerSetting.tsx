import { useState } from 'react';
import { isReturnKeySendsEnabled, setReturnKeySendsEnabled } from '../state/composer.js';

/**
 * "What does Return do in the composer" — a checkbox, mirroring
 * `PreciseLocationSetting`. The default (unchecked) is Return inserts a new
 * line and Cmd/Ctrl+Return sends; checking it makes plain Return send.
 */
export function ComposerSetting() {
  const [enabled, setEnabled] = useState(() => isReturnKeySendsEnabled());

  function toggle(next: boolean): void {
    setReturnKeySendsEnabled(next);
    setEnabled(next);
  }

  return (
    <section className="app-composer-setting">
      <h3>Composer</h3>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => toggle(event.target.checked)}
        />
        Pressing Return sends the message
      </label>
      <p>Otherwise Return starts a new line and Cmd+Return (Ctrl+Return) sends.</p>
    </section>
  );
}

export default ComposerSetting;
