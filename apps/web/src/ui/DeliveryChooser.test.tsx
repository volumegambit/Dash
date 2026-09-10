import { fireEvent, render, screen } from '@testing-library/react';
import { DeliveryChooser } from './DeliveryChooser.js';

describe('DeliveryChooser', () => {
  it('renders the active-response choices with their descriptions and focuses Steer', () => {
    const onChoose = vi.fn();
    render(<DeliveryChooser open onChoose={onChoose} onDismiss={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'A response is in progress' });
    expect(dialog.classList.contains('delivery-chooser')).toBe(true);
    expect(screen.getByText('Guide the response in progress')).toBeTruthy();
    expect(screen.getByText('Send after this response finishes')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Steer' }));

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow Up' }));
    expect(onChoose.mock.calls).toEqual([['steer'], ['followUp']]);
  });

  it('lets Escape own the event and dismisses without choosing a delivery', () => {
    const onChoose = vi.fn();
    const onDismiss = vi.fn();
    const parentEscape = vi.fn();
    window.addEventListener('keydown', parentEscape);

    const view = render(<DeliveryChooser open onChoose={onChoose} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Steer' }), { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();

    view.unmount();
    window.removeEventListener('keydown', parentEscape);
  });

  it('dismisses only for document clicks outside and removes the listener when closed', () => {
    const onDismiss = vi.fn();
    const view = render(
      <>
        <button type="button">Outside</button>
        <DeliveryChooser open onChoose={vi.fn()} onDismiss={onDismiss} />
      </>,
    );

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Follow Up' }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    view.rerender(
      <>
        <button type="button">Outside</button>
        <DeliveryChooser open={false} onChoose={vi.fn()} onDismiss={onDismiss} />
      </>,
    );
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
