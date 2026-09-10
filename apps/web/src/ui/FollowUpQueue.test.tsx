import type { MobileV2PendingInput } from '@dash/mobile-contract-v2';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { FollowUpQueue, type FollowUpQueueProps } from './FollowUpQueue.js';
import { IMAGE_ATTACHMENT_LIMITS } from './attachments.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function input(
  inputId: string,
  enqueueOrder: number,
  patch: Partial<MobileV2PendingInput> = {},
): MobileV2PendingInput {
  return {
    inputId,
    kind: 'follow_up',
    text: `Follow up ${enqueueOrder}`,
    state: 'queued',
    revision: 1,
    enqueueOrder,
    createdAt: '2026-09-06T00:00:00Z',
    updatedAt: '2026-09-06T00:00:00Z',
    ...patch,
  };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: /Edit Follow Up text/ }) as HTMLTextAreaElement;
}

function controlledImage(
  name: string,
  size = 1,
): {
  file: File;
  read: ReturnType<typeof deferred<ArrayBuffer>>;
} {
  const file = new File([new Uint8Array([1])], name, { type: 'image/png' });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  const read = deferred<ArrayBuffer>();
  vi.spyOn(file, 'arrayBuffer').mockImplementation(() => read.promise);
  return { file, read };
}

async function resolveImage(
  read: ReturnType<typeof deferred<ArrayBuffer>>,
  byte: number,
): Promise<void> {
  await act(async () => {
    read.resolve(new Uint8Array([byte]).buffer);
    await Promise.resolve();
  });
}

const baseProps = {
  conversationKey: 'gateway:test',
  paused: false,
  onEdit: vi.fn(async () => {}),
  onRemove: vi.fn(async () => {}),
  onResume: vi.fn(async () => {}),
} satisfies Omit<FollowUpQueueProps, 'items'>;

describe('FollowUpQueue', () => {
  it('renders three Follow Ups in FIFO order with exact item-specific labels and no reorder action', () => {
    render(
      <FollowUpQueue
        {...baseProps}
        items={[input('third', 3), input('first', 1), input('second', 2)]}
      />,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Follow Up, position 1 of 3',
      'Follow Up, position 2 of 3',
      'Follow Up, position 3 of 3',
    ]);
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('Follow up 1'),
      expect.stringContaining('Follow up 2'),
      expect.stringContaining('Follow up 3'),
    ]);
    expect(screen.getByLabelText('Edit Follow Up, position 1 of 3')).toBeTruthy();
    expect(screen.getByLabelText('Remove Follow Up, position 3 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(?:Reorder|Move)\b/i })).toBeNull();
  });

  it('shows delivering state without Edit or Remove controls', () => {
    render(<FollowUpQueue {...baseProps} items={[input('first', 1, { state: 'delivering' })]} />);

    expect(screen.getByText('Delivering…')).toBeTruthy();
    expect(screen.queryByLabelText(/Edit Follow Up/)).toBeNull();
    expect(screen.queryByLabelText(/Remove Follow Up/)).toBeNull();
  });

  it('replaces editor attachments and calls the exact Web edit signature after acknowledgement', async () => {
    const onEdit = vi.fn<FollowUpQueueProps['onEdit']>().mockResolvedValue(undefined);
    render(
      <FollowUpQueue
        {...baseProps}
        items={[input('first', 1, { images: [{ mediaType: 'image/png', data: 'b2xk' }] })]}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.change(editor(), { target: { value: ' edited text ' } });
    fireEvent.click(screen.getByLabelText('Remove editor attachment 1'));
    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: {
        files: [new File([new Uint8Array([4, 5, 6])], 'new.png', { type: 'image/png' })],
      },
    });
    await screen.findByAltText('Editor attachment 1');

    fireEvent.click(button('Save Follow Up'));
    await act(async () => Promise.resolve());

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.slice(0, 3)).toEqual(['first', 1, 'edited text']);
    expect(onEdit.mock.calls[0]?.[3]).toEqual([{ mediaType: 'image/png', data: 'BAUG' }]);
    expect(screen.queryByRole('textbox', { name: /Edit Follow Up text/ })).toBeNull();
  });

  it('focuses the editor on entry and restores focus to the item Edit action after Cancel or Save', async () => {
    const onEdit = vi.fn<FollowUpQueueProps['onEdit']>().mockResolvedValue(undefined);
    render(<FollowUpQueue {...baseProps} items={[input('first', 1)]} onEdit={onEdit} />);

    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    expect(document.activeElement).toBe(editor());

    fireEvent.click(button('Cancel edit'));
    expect(document.activeElement).toBe(screen.getByLabelText('Edit Follow Up, position 1 of 1'));

    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.click(button('Save Follow Up'));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Edit Follow Up, position 1 of 1')),
    );
  });

  it('falls back to the owned composer when a successful Save makes its item vanish', async () => {
    const composerRef = createRef<HTMLTextAreaElement>();

    function VanishingQueue() {
      const [items, setItems] = useState([input('first', 1)]);
      return (
        <>
          <textarea ref={composerRef} aria-label="Owned composer" />
          <FollowUpQueue
            {...baseProps}
            items={items}
            composerRef={composerRef}
            onEdit={async () => setItems([])}
          />
        </>
      );
    }

    render(<VanishingQueue />);
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.click(button('Save Follow Up'));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Owned composer')),
    );
  });

  it('preserves the edit draft and canonical revision when a conflict rejects', async () => {
    const onEdit = vi
      .fn<FollowUpQueueProps['onEdit']>()
      .mockRejectedValueOnce(new Error('Revision conflict'))
      .mockResolvedValue(undefined);
    const view = render(
      <FollowUpQueue {...baseProps} items={[input('first', 1)]} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.change(editor(), { target: { value: 'keep my edit' } });
    fireEvent.click(button('Save Follow Up'));
    expect((await screen.findByRole('alert')).textContent).toContain('Revision conflict');
    expect(editor().value).toBe('keep my edit');

    view.rerender(
      <FollowUpQueue
        {...baseProps}
        items={[input('first', 1, { revision: 2, text: 'remote text' })]}
        onEdit={onEdit}
      />,
    );
    await act(async () => Promise.resolve());
    expect(editor().value).toBe('keep my edit');
    await act(async () => fireEvent.click(button('Save Follow Up')));
    expect(onEdit).toHaveBeenLastCalledWith('first', 2, 'keep my edit', undefined);
  });

  it('binds image reads to the conversation and editor session across A to B to A', async () => {
    const oldImage = controlledImage('old-a.png');
    const currentImage = controlledImage('current-a.png');
    const view = render(
      <FollowUpQueue {...baseProps} conversationKey="gateway:a" items={[input('shared', 1)]} />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: { files: [oldImage.file] },
    });

    view.rerender(
      <FollowUpQueue {...baseProps} conversationKey="gateway:b" items={[input('shared', 1)]} />,
    );
    view.rerender(
      <FollowUpQueue {...baseProps} conversationKey="gateway:a" items={[input('shared', 1)]} />,
    );
    fireEvent.click(await screen.findByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.change(editor(), { target: { value: 'new A editor' } });
    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: { files: [currentImage.file] },
    });

    await resolveImage(oldImage.read, 1);
    expect(screen.queryByAltText(/Editor attachment/)).toBeNull();
    expect(editor().value).toBe('new A editor');
    expect(button('Save Follow Up').disabled).toBe(true);

    await resolveImage(currentImage.read, 2);
    expect(await screen.findByAltText('Editor attachment 1')).toBeTruthy();
    expect(button('Save Follow Up').disabled).toBe(false);
  });

  it('ignores a read from an old item and a cancelled editor session', async () => {
    const oldItemImage = controlledImage('first.png');
    const cancelledImage = controlledImage('cancelled.png');
    render(<FollowUpQueue {...baseProps} items={[input('first', 1), input('second', 2)]} />);
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 2'));
    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: { files: [oldItemImage.file] },
    });
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 2 of 2'));
    await resolveImage(oldItemImage.read, 1);
    expect(editor().value).toBe('Follow up 2');
    expect(screen.queryByAltText(/Editor attachment/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: { files: [cancelledImage.file] },
    });
    fireEvent.click(button('Cancel edit'));
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 2 of 2'));
    fireEvent.change(editor(), { target: { value: 'reopened' } });
    await resolveImage(cancelledImage.read, 2);
    expect(editor().value).toBe('reopened');
    expect(screen.queryByAltText(/Editor attachment/)).toBeNull();
  });

  it('composes overlapping reads from the live image ref and never resurrects a removed image', async () => {
    const first = controlledImage('first.png');
    const second = controlledImage('second.png');
    render(
      <FollowUpQueue
        {...baseProps}
        items={[input('shared', 1, { images: [{ mediaType: 'image/png', data: 'b2xk' }] })]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const attachmentInput = screen.getByLabelText('Attach images to Follow Up');
    fireEvent.change(attachmentInput, { target: { files: [first.file] } });
    fireEvent.change(attachmentInput, { target: { files: [second.file] } });
    fireEvent.click(screen.getByLabelText('Remove editor attachment 1'));

    await resolveImage(second.read, 2);
    await resolveImage(first.read, 1);

    const previews = screen
      .getAllByAltText(/Editor attachment/)
      .map((image) => image.getAttribute('src'));
    expect(previews).toHaveLength(2);
    expect(previews).toEqual(
      expect.arrayContaining(['data:image/png;base64,AQ==', 'data:image/png;base64,Ag==']),
    );
    expect(previews).not.toContain('data:image/png;base64,b2xk');
  });

  it('reserves count and aggregate byte capacity before concurrent reads settle', async () => {
    const large = IMAGE_ATTACHMENT_LIMITS.maxFileBytes;
    const first = controlledImage('first.png', large);
    const second = controlledImage('second.png', large);
    const overflow = controlledImage('overflow.png', large);
    render(<FollowUpQueue {...baseProps} items={[input('shared', 1)]} />);
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const attachmentInput = screen.getByLabelText('Attach images to Follow Up');

    fireEvent.change(attachmentInput, { target: { files: [first.file] } });
    fireEvent.change(attachmentInput, { target: { files: [second.file] } });
    fireEvent.change(attachmentInput, { target: { files: [overflow.file] } });

    expect(button('Save Follow Up').disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Images must total under 12 MB.');
    expect(first.file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(second.file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(overflow.file.arrayBuffer).not.toHaveBeenCalled();

    await resolveImage(first.read, 1);
    expect(button('Save Follow Up').disabled).toBe(true);
    await resolveImage(second.read, 2);
    expect(screen.getAllByAltText(/Editor attachment/)).toHaveLength(2);
    expect(button('Save Follow Up').disabled).toBe(false);
  });

  it('reserves the fourth image slot before its read settles', async () => {
    const fourth = controlledImage('fourth.png');
    const overflow = controlledImage('overflow.png');
    render(
      <FollowUpQueue
        {...baseProps}
        items={[
          input('shared', 1, {
            images: [
              { mediaType: 'image/png', data: 'AQ==' },
              { mediaType: 'image/png', data: 'Ag==' },
              { mediaType: 'image/png', data: 'Aw==' },
            ],
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const attachmentInput = screen.getByLabelText('Attach images to Follow Up');
    fireEvent.change(attachmentInput, { target: { files: [fourth.file] } });
    fireEvent.change(attachmentInput, { target: { files: [overflow.file] } });

    expect(screen.getByRole('alert').textContent).toContain('Maximum 4 images per message.');
    expect(fourth.file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(overflow.file.arrayBuffer).not.toHaveBeenCalled();
    await resolveImage(fourth.read, 4);
    expect(screen.getAllByAltText(/Editor attachment/)).toHaveLength(4);
  });

  it('versions the editor when selection starts so an older Save cannot close over a slow image', async () => {
    const saved = deferred<void>();
    const newerImage = controlledImage('newer.png');
    render(
      <FollowUpQueue {...baseProps} items={[input('shared', 1)]} onEdit={() => saved.promise} />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.click(button('Save Follow Up'));
    fireEvent.change(screen.getByLabelText('Attach images to Follow Up'), {
      target: { files: [newerImage.file] },
    });
    await act(async () => saved.resolve(undefined));

    expect(editor()).toBeTruthy();
    expect(button('Save Follow Up').disabled).toBe(true);
    await resolveImage(newerImage.read, 1);
    expect(await screen.findByAltText('Editor attachment 1')).toBeTruthy();
    expect(button('Save Follow Up').disabled).toBe(false);
  });

  it('keeps only the matching editor open when remote items are removed', async () => {
    const view = render(
      <FollowUpQueue {...baseProps} items={[input('first', 1), input('second', 2)]} />,
    );
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 2 of 2'));
    fireEvent.change(editor(), { target: { value: 'second draft' } });

    view.rerender(<FollowUpQueue {...baseProps} items={[input('second', 2)]} />);
    expect(editor().value).toBe('second draft');

    view.rerender(<FollowUpQueue {...baseProps} items={[input('first', 1)]} />);
    await act(async () => Promise.resolve());
    expect(screen.queryByRole('textbox', { name: /Edit Follow Up text/ })).toBeNull();
    expect(screen.getByLabelText('Edit Follow Up, position 1 of 1')).toBeTruthy();
  });

  it('does not let stale A edit, remove, or resume attempts settle newer A attempts', async () => {
    const oldEdit = deferred<void>();
    const newEdit = deferred<void>();
    const oldRemove = deferred<void>();
    const newRemove = deferred<void>();
    const oldResume = deferred<void>();
    const newResume = deferred<void>();
    let editAttempt = oldEdit;
    let removeAttempt = oldRemove;
    let resumeAttempt = oldResume;
    const props = {
      items: [input('shared', 1)],
      paused: true,
      onEdit: () => editAttempt.promise,
      onRemove: () => removeAttempt.promise,
      onResume: () => resumeAttempt.promise,
    };
    const view = render(<FollowUpQueue {...props} conversationKey="gateway:a" />);
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.click(button('Save Follow Up'));
    fireEvent.click(button('Resume Follow Ups'));

    view.rerender(<FollowUpQueue {...props} conversationKey="gateway:b" />);
    editAttempt = newEdit;
    removeAttempt = newRemove;
    resumeAttempt = newResume;
    view.rerender(<FollowUpQueue {...props} conversationKey="gateway:a" />);
    fireEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    fireEvent.click(button('Save Follow Up'));
    fireEvent.click(button('Resume Follow Ups'));
    expect(button('Save Follow Up').disabled).toBe(true);
    expect(button('Resume Follow Ups').disabled).toBe(true);

    await act(async () => oldEdit.resolve(undefined));
    await act(async () => oldResume.reject(new Error('stale resume')));
    expect(button('Save Follow Up').disabled).toBe(true);
    expect(button('Resume Follow Ups').disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => newEdit.resolve(undefined));
    await act(async () => newResume.resolve(undefined));
    removeAttempt = oldRemove;
    fireEvent.click(screen.getByLabelText('Remove Follow Up, position 1 of 1'));
    view.rerender(<FollowUpQueue {...props} conversationKey="gateway:b" />);
    view.rerender(<FollowUpQueue {...props} conversationKey="gateway:a" />);
    removeAttempt = newRemove;
    fireEvent.click(screen.getByLabelText('Remove Follow Up, position 1 of 1'));
    const currentRemove = button('Remove Follow Up, position 1 of 1');
    expect(currentRemove.disabled).toBe(true);
    await act(async () => oldRemove.resolve(undefined));
    expect(currentRemove.disabled).toBe(true);
    await act(async () => newRemove.resolve(undefined));
  });

  it('moves focus to the next action or its own composer after acknowledged removal', async () => {
    const firstRemoval = deferred<void>();
    const lastRemoval = deferred<void>();
    const composerRef = createRef<HTMLTextAreaElement>();
    let removal = firstRemoval;
    const view = render(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          {...baseProps}
          composerRef={composerRef}
          items={[input('first', 1), input('second', 2)]}
          onRemove={() => removal.promise}
        />
      </>,
    );
    fireEvent.click(screen.getByLabelText('Remove Follow Up, position 1 of 2'));
    await act(async () => firstRemoval.resolve(undefined));
    expect(document.activeElement).toBe(screen.getByLabelText('Edit Follow Up, position 2 of 2'));

    removal = lastRemoval;
    view.rerender(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          {...baseProps}
          composerRef={composerRef}
          items={[input('first', 1), input('second', 2)]}
          onRemove={() => removal.promise}
        />
      </>,
    );
    fireEvent.click(screen.getByLabelText('Remove Follow Up, position 2 of 2'));
    await act(async () => lastRemoval.resolve(undefined));
    expect(document.activeElement).toBe(screen.getByLabelText('Owned composer'));
  });

  it('announces the exact paused copy and resumes explicitly', async () => {
    const resumed = deferred<void>();
    const onResume = vi.fn(() => resumed.promise);
    render(<FollowUpQueue {...baseProps} items={[input('first', 1)]} paused onResume={onResume} />);
    expect(screen.getByRole('status').textContent).toContain('Follow Ups paused');
    fireEvent.click(button('Resume Follow Ups'));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(button('Resume Follow Ups').disabled).toBe(true);
    await act(async () => resumed.resolve(undefined));
    expect(button('Resume Follow Ups').disabled).toBe(false);
  });
});
