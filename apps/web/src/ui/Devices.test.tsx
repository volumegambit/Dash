import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PairingInfo } from '../auth/control-plane.js';
import { Devices } from './Devices.js';

const CURRENT_PAIRING: PairingInfo = {
  id: 'p-current',
  deviceLabel: 'Web · Chrome',
  clientKind: 'web',
  status: 'active',
};
const OTHER_PAIRING: PairingInfo = {
  id: 'p-other',
  deviceLabel: 'iPhone 15',
  clientKind: 'mobile',
  status: 'active',
};

describe('Devices', () => {
  it('lists pairings with a clientKind badge', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [CURRENT_PAIRING, OTHER_PAIRING]),
      deletePairing: vi.fn(),
    };
    const credentialStore = { delete: vi.fn() };

    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        onCurrentDeviceRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Web · Chrome')).toBeTruthy());
    expect(screen.getByText('iPhone 15')).toBeTruthy();
    const kinds = screen.getAllByTestId('pairing-client-kind').map((el) => el.textContent);
    expect(kinds).toEqual(['web', 'mobile']);
    expect(controlPlaneClient.listPairings).toHaveBeenCalledWith('gw-1');
  });

  it('marks the row that matches currentPairingId as "This device"', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [CURRENT_PAIRING, OTHER_PAIRING]),
      deletePairing: vi.fn(),
    };
    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={{ delete: vi.fn() }}
        onCurrentDeviceRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('This device')).toBeTruthy());
    const rows = screen.getAllByTestId('pairing-row');
    expect(rows[0].textContent).toContain('This device');
    expect(rows[1].textContent).not.toContain('This device');
  });

  it('revokes a non-current device: calls deletePairing and removes the row, without touching the credential store', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [CURRENT_PAIRING, OTHER_PAIRING]),
      deletePairing: vi.fn(async () => undefined),
    };
    const credentialStore = { delete: vi.fn() };
    const onCurrentDeviceRevoked = vi.fn();

    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        onCurrentDeviceRevoked={onCurrentDeviceRevoked}
      />,
    );

    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeTruthy());
    const otherRow = screen.getByText('iPhone 15').closest('li') as HTMLLIElement;
    fireEvent.click(within(otherRow).getByText('Revoke'));

    await waitFor(() => expect(screen.queryByText('iPhone 15')).toBeNull());
    expect(controlPlaneClient.deletePairing).toHaveBeenCalledWith('gw-1', 'p-other');
    expect(credentialStore.delete).not.toHaveBeenCalled();
    expect(onCurrentDeviceRevoked).not.toHaveBeenCalled();
    expect(screen.getByText('Web · Chrome')).toBeTruthy();
  });

  it('revoking the CURRENT device also clears the CredentialStore and calls onCurrentDeviceRevoked', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [CURRENT_PAIRING, OTHER_PAIRING]),
      deletePairing: vi.fn(async () => undefined),
    };
    const credentialStore = { delete: vi.fn(async () => undefined) };
    const onCurrentDeviceRevoked = vi.fn();

    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        onCurrentDeviceRevoked={onCurrentDeviceRevoked}
      />,
    );

    await waitFor(() => expect(screen.getByText('Web · Chrome')).toBeTruthy());
    const currentRow = screen.getByText('Web · Chrome').closest('li') as HTMLLIElement;
    fireEvent.click(within(currentRow).getByText('Revoke'));

    await waitFor(() => expect(onCurrentDeviceRevoked).toHaveBeenCalledTimes(1));
    expect(controlPlaneClient.deletePairing).toHaveBeenCalledWith('gw-1', 'p-current');
    expect(credentialStore.delete).toHaveBeenCalledWith('gw-1');
    expect(screen.queryByText('Web · Chrome')).toBeNull();
  });

  it('still calls onCurrentDeviceRevoked when deletePairing succeeds but the local credentialStore.delete throws', async () => {
    // The server-side pairing is dead either way once deletePairing
    // succeeds — a failure to also clear the *local* credential must not
    // strand the user on a Devices screen backed by a revoked pairing.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [CURRENT_PAIRING]),
      deletePairing: vi.fn(async () => undefined),
    };
    const credentialStore = {
      delete: vi.fn(async () => {
        throw new Error('IndexedDB is unavailable');
      }),
    };
    const onCurrentDeviceRevoked = vi.fn();

    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={credentialStore}
        onCurrentDeviceRevoked={onCurrentDeviceRevoked}
      />,
    );

    await waitFor(() => expect(screen.getByText('Web · Chrome')).toBeTruthy());
    fireEvent.click(screen.getByText('Revoke'));

    await waitFor(() => expect(onCurrentDeviceRevoked).toHaveBeenCalledTimes(1));
    expect(controlPlaneClient.deletePairing).toHaveBeenCalledWith('gw-1', 'p-current');
    expect(credentialStore.delete).toHaveBeenCalledWith('gw-1');
    expect(screen.queryByText('Web · Chrome')).toBeNull(); // row still removed regardless
    consoleError.mockRestore();
  });

  it('surfaces an error and leaves the row in place when deletePairing fails', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => [OTHER_PAIRING]),
      deletePairing: vi.fn(async () => {
        throw new Error('network blip');
      }),
    };
    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={{ delete: vi.fn() }}
        onCurrentDeviceRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeTruthy());
    fireEvent.click(screen.getByText('Revoke'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('iPhone 15')).toBeTruthy();
  });

  it('shows an empty state when there are no paired devices', async () => {
    const controlPlaneClient = {
      listPairings: vi.fn(async () => []),
      deletePairing: vi.fn(),
    };
    render(
      <Devices
        gatewayId="gw-1"
        currentPairingId="p-current"
        controlPlaneClient={controlPlaneClient}
        credentialStore={{ delete: vi.fn() }}
        onCurrentDeviceRevoked={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('No paired devices.')).toBeTruthy());
  });
});
