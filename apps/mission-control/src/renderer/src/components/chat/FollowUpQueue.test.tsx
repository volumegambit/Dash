import '@testing-library/jest-dom/vitest';
import type { MobileV2PendingInput } from '@dash/mobile-contract-v2';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import type { ChatInputPayload } from './ChatComposer.js';
import { FollowUpQueue, type FollowUpQueueProps } from './FollowUpQueue.js';

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

interface ControlledFileReader {
  resolve(result: string): void;
}

function installControlledFileReaders(): ControlledFileReader[] {
  const readers: ControlledFileReader[] = [];
  class ControlledReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsDataURL(): void {
      readers.push(this);
    }

    resolve(result: string): void {
      this.result = result;
      this.onload?.();
    }
  }
  vi.stubGlobal('FileReader', ControlledReader);
  return readers;
}

afterEach(() => vi.unstubAllGlobals());

describe('FollowUpQueue', () => {
  it('renders FIFO positions and item-specific actions', () => {
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('second', 2), input('first', 1)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAccessibleName('Follow Up, position 1 of 2');
    expect(cards[0]).toHaveTextContent('Follow up 1');
    expect(screen.getByLabelText('Edit Follow Up, position 1 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Follow Up, position 2 of 2')).toBeInTheDocument();
  });

  it('hides edit and remove while an item is delivering', () => {
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1, { state: 'delivering' })]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText('Delivering…')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Edit Follow Up/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Remove Follow Up/)).not.toBeInTheDocument();
  });

  it('closes an open editor when the item begins delivering', async () => {
    const props = {
      conversationKey: 'gateway:test',
      paused: false,
      onEdit: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(<FollowUpQueue {...props} items={[input('first', 1)]} />);
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    expect(screen.getByLabelText('Edit Follow Up text, position 1 of 1')).toBeInTheDocument();

    view.rerender(
      <FollowUpQueue {...props} items={[input('first', 1, { state: 'delivering' })]} />,
    );

    await waitFor(() => expect(screen.queryByLabelText(/Edit Follow Up/)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Save Follow Up' })).not.toBeInTheDocument();
  });

  it('keeps editor text after a conflict and retries the same revision', async () => {
    const onEdit = vi.fn().mockRejectedValueOnce(new Error('Revision conflict'));
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1)]}
        paused={false}
        onEdit={onEdit}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const editor = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'keep my edit');
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Revision conflict');
    expect(editor).toHaveValue('keep my edit');
    expect(onEdit).toHaveBeenCalledWith('first', 1, { text: 'keep my edit' });
  });

  it('does not let a late edit acknowledgement close a newer item editor', async () => {
    const savedFirst = deferred<void>();
    const onEdit = vi.fn((inputId: string) =>
      inputId === 'first' ? savedFirst.promise : Promise.resolve(),
    );
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1), input('second', 2)]}
        paused={false}
        onEdit={onEdit}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 2'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 2 of 2'));
    const secondEditor = screen.getByLabelText('Edit Follow Up text, position 2 of 2');
    await userEvent.clear(secondEditor);
    await userEvent.type(secondEditor, 'newer second draft');

    savedFirst.resolve(undefined);

    await waitFor(() => expect(secondEditor).toHaveValue('newer second draft'));
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeInTheDocument();
  });

  it('keeps the editor open when the canonical revision advances before save settlement', async () => {
    const saved = deferred<void>();
    const onEdit = vi
      .fn<FollowUpQueueProps['onEdit']>()
      .mockImplementationOnce(() => saved.promise)
      .mockResolvedValue(undefined);
    const props = {
      conversationKey: 'gateway:conversation-x',
      paused: false,
      onEdit,
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(
      <FollowUpQueue
        {...props}
        items={[input('shared-input', 1, { text: 'canonical revision one' })]}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const editor = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'draft submitted against revision one');
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    view.rerender(
      <FollowUpQueue
        {...props}
        items={[
          input('shared-input', 1, {
            revision: 2,
            text: 'canonical revision two',
          }),
        ]}
      />,
    );
    await act(async () => saved.resolve(undefined));

    expect(screen.getByLabelText('Edit Follow Up text, position 1 of 1')).toHaveValue(
      'draft submitted against revision one',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    expect(onEdit).toHaveBeenLastCalledWith('shared-input', 2, {
      text: 'draft submitted against revision one',
    });
  });

  it('ignores a rejected save after switching conversations and opening the next editor', async () => {
    const savedA = deferred<void>();
    const savedB = deferred<void>();
    const baseProps = {
      paused: false,
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-a"
        items={[input('shared-input', 1, { text: 'conversation A' })]}
        onEdit={() => savedA.promise}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    view.rerender(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-b"
        items={[input('shared-input', 1, { text: 'conversation B' })]}
        onEdit={() => savedB.promise}
      />,
    );
    const editB = await screen.findByLabelText('Edit Follow Up, position 1 of 1');
    expect(editB).toBeEnabled();
    await userEvent.click(editB);
    const editorB = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editorB);
    await userEvent.type(editorB, 'conversation B draft');
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    await act(async () => savedA.reject(new Error('stale conversation A rejection')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(editorB).toHaveValue('conversation B draft');
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeDisabled();
    await act(async () => savedB.resolve(undefined));
  });

  it('does not clear a newer same-item edit after returning to the original conversation', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    const baseProps = {
      paused: false,
      items: [input('shared-input', 1)],
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-a"
        onEdit={() => firstSave.promise}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    view.rerender(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-b"
        onEdit={vi.fn(async () => {})}
      />,
    );
    view.rerender(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-a"
        onEdit={() => secondSave.promise}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    const currentSave = screen.getByRole('button', { name: 'Save Follow Up' });
    expect(currentSave).toBeDisabled();

    await act(async () => firstSave.resolve(undefined));

    expect(currentSave).toBeDisabled();
    expect(screen.getByLabelText('Edit Follow Up text, position 1 of 1')).toBeInTheDocument();
    await act(async () => secondSave.resolve(undefined));
  });

  it('replaces editor attachments before committing', async () => {
    const onEdit = vi.fn(
      async (_inputId: string, _revision: number, _payload: ChatInputPayload) => {},
    );
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[
          input('first', 1, {
            images: [{ mediaType: 'image/png', data: 'b2xk' }],
          }),
        ]}
        paused={false}
        onEdit={onEdit}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.click(screen.getByLabelText('Remove editor attachment 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([4, 5, 6])], 'new.png', { type: 'image/png' }),
    );
    await screen.findByAltText('Editor attachment 1');
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));

    await waitFor(() => expect(onEdit).toHaveBeenCalledTimes(1));
    const payload = onEdit.mock.calls[0]?.[2];
    expect(payload?.images).toEqual([expect.objectContaining({ mediaType: 'image/png' })]);
    expect(payload?.images?.[0]?.data).not.toBe('b2xk');
  });

  it('ignores a completed attachment read after switching conversations', async () => {
    const readers = installControlledFileReaders();
    const baseProps = {
      items: [input('shared-input', 1)],
      paused: false,
      onEdit: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(<FollowUpQueue {...baseProps} conversationKey="gateway:conversation-a" />);
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'conversation-a.png', { type: 'image/png' }),
    );

    view.rerender(<FollowUpQueue {...baseProps} conversationKey="gateway:conversation-b" />);
    await userEvent.click(await screen.findByLabelText('Edit Follow Up, position 1 of 1'));
    const editor = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'conversation B draft');
    expect(readers).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));

    expect(screen.queryByAltText(/Editor attachment/)).not.toBeInTheDocument();
    expect(editor).toHaveValue('conversation B draft');
  });

  it('ignores a completed attachment read after changing the edited item', async () => {
    const readers = installControlledFileReaders();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1), input('second', 2)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 2'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'first-item.png', { type: 'image/png' }),
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 2 of 2'));
    expect(readers).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));

    expect(screen.queryByAltText(/Editor attachment/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit Follow Up text, position 2 of 2')).toHaveValue(
      'Follow up 2',
    );
  });

  it('ignores a completed attachment read after cancelling and reopening the editor', async () => {
    const readers = installControlledFileReaders();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('shared-input', 1)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'old-session.png', { type: 'image/png' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const editor = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'reopened draft');
    expect(readers).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));

    expect(screen.queryByAltText(/Editor attachment/)).not.toBeInTheDocument();
    expect(editor).toHaveValue('reopened draft');
  });

  it('ignores an old same-item attachment read after returning to the conversation', async () => {
    const readers = installControlledFileReaders();
    const baseProps = {
      items: [input('shared-input', 1)],
      paused: false,
      onEdit: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(<FollowUpQueue {...baseProps} conversationKey="gateway:conversation-a" />);
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'first-a-session.png', { type: 'image/png' }),
    );

    view.rerender(<FollowUpQueue {...baseProps} conversationKey="gateway:conversation-b" />);
    view.rerender(<FollowUpQueue {...baseProps} conversationKey="gateway:conversation-a" />);
    await userEvent.click(await screen.findByLabelText('Edit Follow Up, position 1 of 1'));
    expect(readers).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));

    expect(screen.queryByAltText(/Editor attachment/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Edit Follow Up text, position 1 of 1')).toHaveValue(
      'Follow up 1',
    );
  });

  it('composes overlapping attachment reads without losing text or a newer attachment', async () => {
    const readers = installControlledFileReaders();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('shared-input', 1)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    const attachmentInput = screen.getByLabelText('Attach images to Follow Up');
    await userEvent.upload(
      attachmentInput,
      new File([new Uint8Array([1])], 'first.png', { type: 'image/png' }),
    );
    await userEvent.upload(
      attachmentInput,
      new File([new Uint8Array([2])], 'second.png', { type: 'image/png' }),
    );
    const editor = screen.getByLabelText('Edit Follow Up text, position 1 of 1');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'text edited while reading');
    expect(readers).toHaveLength(2);

    await act(async () => readers[1]?.resolve('data:image/png;base64,Qg=='));
    expect(screen.getAllByAltText(/Editor attachment/)).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));

    const previews = screen
      .getAllByAltText(/Editor attachment/)
      .map((attachment) => attachment.getAttribute('src'));
    expect(previews).toEqual(
      expect.arrayContaining(['data:image/png;base64,QQ==', 'data:image/png;base64,Qg==']),
    );
    expect(previews).toHaveLength(2);
    expect(editor).toHaveValue('text edited while reading');
  });

  it('does not resurrect an attachment removed while another attachment is reading', async () => {
    const readers = installControlledFileReaders();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[
          input('shared-input', 1, {
            images: [{ mediaType: 'image/png', data: 'b2xk' }],
          }),
        ]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'replacement.png', { type: 'image/png' }),
    );
    await userEvent.click(screen.getByLabelText('Remove editor attachment 1'));
    expect(screen.queryByAltText(/Editor attachment/)).not.toBeInTheDocument();

    expect(readers).toHaveLength(1);
    await act(async () => readers[0]?.resolve('data:image/png;base64,bmV3'));

    const previews = screen
      .getAllByAltText(/Editor attachment/)
      .map((attachment) => attachment.getAttribute('src'));
    expect(previews).toEqual(['data:image/png;base64,bmV3']);
  });

  it('disables Save until a selected attachment finishes reading and includes it', async () => {
    const readers = installControlledFileReaders();
    const onEdit = vi.fn(async () => {});
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('shared-input', 1)]}
        paused={false}
        onEdit={onEdit}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'pending.png', { type: 'image/png' }),
    );

    expect(readers).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeDisabled();
    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));
    expect(await screen.findByAltText('Editor attachment 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    expect(onEdit).toHaveBeenCalledWith('shared-input', 1, {
      text: 'Follow up 1',
      images: [{ mediaType: 'image/png', data: 'QQ==' }],
    });
  });

  it('does not let an old read completion enable Save in a newer editor session', async () => {
    const readers = installControlledFileReaders();
    const props = {
      items: [input('shared-input', 1)],
      paused: false,
      onEdit: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(<FollowUpQueue {...props} conversationKey="gateway:a" />);
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
    );

    view.rerender(<FollowUpQueue {...props} conversationKey="gateway:b" />);
    await userEvent.click(await screen.findByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }),
    );
    expect(readers).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeDisabled();

    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeDisabled();
    await act(async () => readers[1]?.resolve('data:image/png;base64,Qg=='));
    expect(await screen.findByAltText('Editor attachment 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeEnabled();
  });

  it('keeps the editor open when an image is selected during a pending save', async () => {
    const readers = installControlledFileReaders();
    const saved = deferred<void>();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('shared-input', 1)]}
        paused={false}
        onEdit={() => saved.promise}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Follow Up' }));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      new File([new Uint8Array([1])], 'newer.png', { type: 'image/png' }),
    );
    expect(readers).toHaveLength(1);

    await act(async () => saved.resolve(undefined));
    expect(screen.getByLabelText('Edit Follow Up text, position 1 of 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeDisabled();

    await act(async () => readers[0]?.resolve('data:image/png;base64,QQ=='));
    expect(await screen.findByAltText('Editor attachment 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Follow Up' })).toBeEnabled();
  });

  it('enforces the shared four-image limit in the queue editor', async () => {
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Edit Follow Up, position 1 of 1'));
    await userEvent.upload(
      screen.getByLabelText('Attach images to Follow Up'),
      Array.from(
        { length: 5 },
        (_, index) =>
          new File([new Uint8Array([index])], `image-${index}.png`, { type: 'image/png' }),
      ),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Maximum 4 images per message.');
    expect(screen.getAllByAltText(/Editor attachment/)).toHaveLength(4);
  });

  it('focuses the next item after acknowledged removal', async () => {
    const removed = deferred<void>();
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1), input('second', 2)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={() => removed.promise}
        onResume={vi.fn(async () => {})}
      />,
    );
    await userEvent.click(screen.getByLabelText('Remove Follow Up, position 1 of 2'));
    expect(screen.getByLabelText('Remove Follow Up, position 1 of 2')).toBeDisabled();
    removed.resolve(undefined);

    await waitFor(() =>
      expect(screen.getByLabelText('Edit Follow Up, position 2 of 2')).toHaveFocus(),
    );
  });

  it('keeps edit and remove disabled per item across concurrent removals', async () => {
    const removals = {
      first: deferred<void>(),
      second: deferred<void>(),
    };
    const onRemove = vi.fn((inputId: string) => removals[inputId as keyof typeof removals].promise);
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1), input('second', 2)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={onRemove}
        onResume={vi.fn(async () => {})}
      />,
    );
    const editFirst = screen.getByLabelText('Edit Follow Up, position 1 of 2');
    const removeFirst = screen.getByLabelText('Remove Follow Up, position 1 of 2');
    const editSecond = screen.getByLabelText('Edit Follow Up, position 2 of 2');
    const removeSecond = screen.getByLabelText('Remove Follow Up, position 2 of 2');

    await userEvent.click(removeFirst);
    expect(editFirst).toBeDisabled();
    expect(removeFirst).toBeDisabled();
    await userEvent.click(removeSecond);
    expect(editFirst).toBeDisabled();
    expect(removeFirst).toBeDisabled();
    expect(editSecond).toBeDisabled();
    expect(removeSecond).toBeDisabled();
    expect(onRemove).toHaveBeenCalledTimes(2);

    await act(async () => removals.first.resolve(undefined));
    await waitFor(() => expect(removeSecond).toBeDisabled());
    expect(editSecond).toBeDisabled();
    await act(async () => removals.second.resolve(undefined));
    await waitFor(() => expect(removeSecond).toBeEnabled());
  });

  it('does not settle a newer same-item removal after returning to the original conversation', async () => {
    const firstRemoval = deferred<void>();
    const secondRemoval = deferred<void>();
    const composerRef = createRef<HTMLTextAreaElement>();
    const baseProps = {
      paused: false,
      items: [input('shared-input', 1)],
      composerRef,
      onEdit: vi.fn(async () => {}),
      onResume: vi.fn(async () => {}),
    };
    const view = render(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          {...baseProps}
          conversationKey="gateway:conversation-a"
          onRemove={() => firstRemoval.promise}
        />
      </>,
    );
    await userEvent.click(screen.getByLabelText('Remove Follow Up, position 1 of 1'));

    view.rerender(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          {...baseProps}
          conversationKey="gateway:conversation-b"
          onRemove={vi.fn(async () => {})}
        />
      </>,
    );
    view.rerender(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          {...baseProps}
          conversationKey="gateway:conversation-a"
          onRemove={() => secondRemoval.promise}
        />
      </>,
    );
    const currentRemove = screen.getByLabelText('Remove Follow Up, position 1 of 1');
    const currentEdit = screen.getByLabelText('Edit Follow Up, position 1 of 1');
    await userEvent.click(currentRemove);
    expect(currentRemove).toBeDisabled();

    await act(async () => firstRemoval.resolve(undefined));

    expect(currentRemove).toBeDisabled();
    expect(currentEdit).toBeDisabled();
    expect(screen.getByLabelText('Owned composer')).not.toHaveFocus();
    await act(async () => secondRemoval.resolve(undefined));
  });

  it('focuses its composer instead of the previous item after removing the last item', async () => {
    const removed = deferred<void>();
    const composerRef = createRef<HTMLTextAreaElement>();
    render(
      <>
        <textarea ref={composerRef} aria-label="Owned composer" />
        <FollowUpQueue
          conversationKey="gateway:test"
          items={[input('first', 1), input('second', 2)]}
          paused={false}
          composerRef={composerRef}
          onEdit={vi.fn(async () => {})}
          onRemove={() => removed.promise}
          onResume={vi.fn(async () => {})}
        />
      </>,
    );
    await userEvent.click(screen.getByLabelText('Remove Follow Up, position 2 of 2'));
    removed.resolve(undefined);

    await waitFor(() => expect(screen.getByLabelText('Owned composer')).toHaveFocus());
  });

  it('focuses the composer owned by its queue when two surfaces are mounted', async () => {
    const firstComposerRef = createRef<HTMLTextAreaElement>();
    const secondComposerRef = createRef<HTMLTextAreaElement>();
    const removed = deferred<void>();
    render(
      <>
        <div data-testid="first-surface">
          <textarea ref={firstComposerRef} aria-label="First composer" />
          <FollowUpQueue
            conversationKey="gateway:first-surface"
            items={[input('first', 1)]}
            paused={false}
            composerRef={firstComposerRef}
            onEdit={vi.fn(async () => {})}
            onRemove={vi.fn(async () => {})}
            onResume={vi.fn(async () => {})}
          />
        </div>
        <div data-testid="second-surface">
          <textarea ref={secondComposerRef} aria-label="Second composer" />
          <FollowUpQueue
            conversationKey="gateway:second-surface"
            items={[input('second', 1)]}
            paused={false}
            composerRef={secondComposerRef}
            onEdit={vi.fn(async () => {})}
            onRemove={() => removed.promise}
            onResume={vi.fn(async () => {})}
          />
        </div>
      </>,
    );
    const secondSurface = within(screen.getByTestId('second-surface'));
    await userEvent.click(secondSurface.getByLabelText('Remove Follow Up, position 1 of 1'));
    removed.resolve(undefined);

    await waitFor(() => expect(screen.getByLabelText('Second composer')).toHaveFocus());
    expect(screen.getByLabelText('First composer')).not.toHaveFocus();
  });

  it('announces a paused queue and resumes it explicitly', async () => {
    const onResume = vi.fn(async () => {});
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1)]}
        paused
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={onResume}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Follow Ups paused');
    await userEvent.click(screen.getByRole('button', { name: 'Resume Follow Ups' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not settle a newer resume after returning to the original conversation', async () => {
    const firstResume = deferred<void>();
    const secondResume = deferred<void>();
    const baseProps = {
      paused: true,
      items: [input('shared-input', 1)],
      onEdit: vi.fn(async () => {}),
      onRemove: vi.fn(async () => {}),
    };
    const view = render(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-a"
        onResume={() => firstResume.promise}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Resume Follow Ups' }));

    view.rerender(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-b"
        onResume={vi.fn(async () => {})}
      />,
    );
    view.rerender(
      <FollowUpQueue
        {...baseProps}
        conversationKey="gateway:conversation-a"
        onResume={() => secondResume.promise}
      />,
    );
    const currentResume = screen.getByRole('button', { name: 'Resume Follow Ups' });
    await userEvent.click(currentResume);
    expect(currentResume).toBeDisabled();

    await act(async () => firstResume.reject(new Error('stale resume failure')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(currentResume).toBeDisabled();
    await act(async () => secondResume.resolve(undefined));
  });

  it('does not add motion classes when reduced motion is requested', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, media: '(prefers-reduced-motion: reduce)' }),
    );
    render(
      <FollowUpQueue
        conversationKey="gateway:test"
        items={[input('first', 1)]}
        paused={false}
        onEdit={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onResume={vi.fn(async () => {})}
      />,
    );
    expect(
      within(screen.getByRole('article')).getByText('Follow up 1').parentElement,
    ).not.toHaveClass('transition-colors');
    vi.unstubAllGlobals();
  });
});
