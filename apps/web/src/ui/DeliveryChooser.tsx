import { type ReactNode, useEffect, useId, useRef } from 'react';

export interface DeliveryChooserProps {
  open: boolean;
  onChoose(behavior: 'steer' | 'followUp'): void;
  onDismiss(): void;
}

export function DeliveryChooser({ open, onChoose, onDismiss }: DeliveryChooserProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const steerDescriptionId = useId();
  const followUpDescriptionId = useId();

  useEffect(() => {
    if (!open) return;

    firstChoiceRef.current?.focus();

    const dismissOutside = (event: MouseEvent): void => {
      const target = event.target;
      if (target instanceof Node && !dialogRef.current?.contains(target)) onDismiss();
    };
    const dismissWithEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };

    document.addEventListener('mousedown', dismissOutside);
    document.addEventListener('keydown', dismissWithEscape, true);
    return () => {
      document.removeEventListener('mousedown', dismissOutside);
      document.removeEventListener('keydown', dismissWithEscape, true);
    };
  }, [onDismiss, open]);

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      open
      aria-label="A response is in progress"
      className="delivery-chooser"
    >
      <p className="delivery-chooser-title">A response is in progress</p>
      <button
        ref={firstChoiceRef}
        type="button"
        aria-label="Steer"
        aria-describedby={steerDescriptionId}
        className="delivery-chooser-option"
        onClick={() => onChoose('steer')}
      >
        <strong>Steer</strong>
        <span id={steerDescriptionId}>Guide the response in progress</span>
      </button>
      <button
        type="button"
        aria-label="Follow Up"
        aria-describedby={followUpDescriptionId}
        className="delivery-chooser-option"
        onClick={() => onChoose('followUp')}
      >
        <strong>Follow Up</strong>
        <span id={followUpDescriptionId}>Send after this response finishes</span>
      </button>
    </dialog>
  );
}
