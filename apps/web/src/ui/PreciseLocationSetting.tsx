import { useState } from 'react';
import {
  isPreciseLocationAvailable,
  isPreciseLocationEnabled,
  setPreciseLocationEnabled,
} from '../state/location.js';

/**
 * Opt-in control for sharing a precise position with the agent.
 *
 * The coarse tier (time zone, locale, region) is always sent and needs no
 * consent — it comes from the same `Intl` data every locale-aware page reads.
 * Only the precise position is gated here, and it is off until the user turns
 * it on AND the browser grants the permission.
 *
 * `navigator.geolocation` requires a secure context, so a gateway reached over
 * a plain `http://` LAN URL cannot use it at all. In that case the control is
 * disabled and says why, rather than offering a switch that silently does
 * nothing.
 */
export function PreciseLocationSetting() {
  const available = isPreciseLocationAvailable();
  const [enabled, setEnabled] = useState(() => isPreciseLocationEnabled());

  function toggle(next: boolean): void {
    setPreciseLocationEnabled(next);
    setEnabled(next);
  }

  return (
    <section className="app-location-setting">
      <h3>Location</h3>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!available}
          onChange={(event) => toggle(event.target.checked)}
        />
        Share precise location
      </label>
      {available ? (
        <p>
          Your agent already knows your time zone and region. Turning this on also shares your
          approximate coordinates, which are stored with the conversation.
        </p>
      ) : (
        <p role="note">
          Precise location needs a secure (HTTPS) connection to your gateway. Your agent still knows
          your time zone and region.
        </p>
      )}
    </section>
  );
}

export default PreciseLocationSetting;
