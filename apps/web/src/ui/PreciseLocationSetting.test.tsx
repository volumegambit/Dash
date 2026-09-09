import { fireEvent, render, screen } from '@testing-library/react';
import { __resetPreciseLocationForTests, isPreciseLocationEnabled } from '../state/location.js';
import { PreciseLocationSetting } from './PreciseLocationSetting.js';

describe('PreciseLocationSetting', () => {
  beforeEach(() => {
    __resetPreciseLocationForTests();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function secureContext(): void {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { language: 'en-SG', geolocation: { getCurrentPosition() {} } });
  }

  it('is off by default and turns the opt-in on', () => {
    secureContext();
    render(<PreciseLocationSetting />);
    const box = screen.getByRole('checkbox', {
      name: /share precise location/i,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);

    fireEvent.click(box);

    expect(box.checked).toBe(true);
    expect(isPreciseLocationEnabled()).toBe(true);
  });

  it('turns the opt-in back off', () => {
    secureContext();
    render(<PreciseLocationSetting />);
    const box = screen.getByRole('checkbox', { name: /share precise location/i });
    fireEvent.click(box);
    fireEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(isPreciseLocationEnabled()).toBe(false);
  });

  it('explains that coarse location still works', () => {
    secureContext();
    render(<PreciseLocationSetting />);
    expect(screen.getByText(/stored with the conversation/i)).toBeTruthy();
  });

  it('disables the control and says why outside a secure context', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('navigator', { language: 'en-SG', geolocation: { getCurrentPosition() {} } });
    render(<PreciseLocationSetting />);
    const box = screen.getByRole('checkbox', {
      name: /share precise location/i,
    }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/secure \(HTTPS\) connection/i);
  });
});
