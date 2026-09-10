import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatComposer, type ChatComposerProps } from './ChatComposer.js';

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

const activeCapableProps: ChatComposerProps = {
  conversationKey: 'gateway:conversation-1',
  activeTurnId: 'run-1',
  queueCapable: true,
  editable: true,
  queuePaused: false,
  placeholder: 'Message…',
  onSend: vi.fn(async () => {}),
  onEnqueue: vi.fn(async () => {}),
  onStop: vi.fn(),
};

describe('ChatComposer', () => {
  it('preserves text and images when Escape dismisses the active-response chooser', async () => {
    render(<ChatComposer {...activeCapableProps} />);
    await userEvent.type(screen.getByLabelText('Message'), 'focus on reconnect');
    await userEvent.upload(
      screen.getByLabelText('Attach images'),
      new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' }),
    );
    await screen.findByAltText('Attachment 1');
    await userEvent.click(screen.getByLabelText('Send message'));

    expect(screen.getByRole('dialog', { name: 'A response is in progress' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    expect(screen.getByLabelText('Message')).toHaveValue('focus on reconnect');
    expect(screen.getByAltText('Attachment 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveFocus();
  });

  it('clears only after the selected delivery receives durable acknowledgement', async () => {
    const acknowledged = deferred<void>();
    render(<ChatComposer {...activeCapableProps} onEnqueue={() => acknowledged.promise} />);
    await userEvent.type(screen.getByLabelText('Message'), 'run this later');
    await userEvent.click(screen.getByLabelText('Send message'));
    await userEvent.click(screen.getByRole('button', { name: 'Follow Up' }));

    expect(screen.getByLabelText('Message')).toHaveValue('run this later');
    acknowledged.resolve(undefined);
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue(''));
  });

  it.each([
    ['ordinary Send', false],
    ['Follow Up', true],
  ] as const)(
    'does not let a late %s acknowledgement clear another conversation draft',
    async (_label, queued) => {
      const acknowledged = deferred<void>();
      const props = {
        ...activeCapableProps,
        activeTurnId: queued ? 'run-1' : null,
        onSend: () => acknowledged.promise,
        onEnqueue: () => acknowledged.promise,
      };
      const view = render(<ChatComposer {...props} conversationKey="gateway:a" />);
      await userEvent.type(screen.getByLabelText('Message'), 'draft A');
      await userEvent.click(screen.getByLabelText('Send message'));
      if (queued) await userEvent.click(screen.getByRole('button', { name: 'Follow Up' }));

      view.rerender(<ChatComposer {...props} conversationKey="gateway:b" />);
      await userEvent.type(screen.getByLabelText('Message'), 'draft B');
      expect(screen.getByLabelText('Send message')).toBeEnabled();
      acknowledged.resolve(undefined);

      await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue('draft B'));
      view.rerender(<ChatComposer {...props} conversationKey="gateway:a" />);
      expect(screen.getByLabelText('Message')).toHaveValue('');
    },
  );

  it('reserves image capacity and disables Send while a selected image is reading', async () => {
    render(<ChatComposer {...activeCapableProps} activeTurnId={null} />);
    await userEvent.upload(
      screen.getByLabelText('Attach images'),
      Array.from(
        { length: 3 },
        (_, index) =>
          new File([new Uint8Array([index])], `existing-${index}.png`, { type: 'image/png' }),
      ),
    );
    await waitFor(() => expect(screen.getAllByAltText(/Attachment/)).toHaveLength(3));
    expect(screen.getByLabelText('Send message')).toBeEnabled();

    const readers = installControlledFileReaders();
    const input = screen.getByLabelText('Attach images');
    await userEvent.upload(
      input,
      new File([new Uint8Array([4])], 'fourth.png', { type: 'image/png' }),
    );

    expect(readers).toHaveLength(1);
    expect(screen.getByLabelText('Send message')).toBeDisabled();
    await userEvent.upload(
      input,
      new File([new Uint8Array([5])], 'overflow.png', { type: 'image/png' }),
    );
    expect(readers).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Maximum 4 images per message.');

    await act(async () => readers[0]?.resolve('data:image/png;base64,RA=='));
    await waitFor(() => expect(screen.getAllByAltText(/Attachment/)).toHaveLength(4));
    expect(screen.getByLabelText('Send message')).toBeEnabled();
  });

  it('keeps a rejected attempt error scoped to its captured conversation', async () => {
    const rejected = deferred<void>();
    const props = {
      ...activeCapableProps,
      activeTurnId: null,
      onSend: () => rejected.promise,
    };
    const view = render(<ChatComposer {...props} conversationKey="gateway:a" />);
    await userEvent.type(screen.getByLabelText('Message'), 'draft A');
    await userEvent.click(screen.getByLabelText('Send message'));

    view.rerender(<ChatComposer {...props} conversationKey="gateway:b" />);
    rejected.reject(new Error('A was rejected'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());

    view.rerender(<ChatComposer {...props} conversationKey="gateway:a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('A was rejected');
    expect(screen.getByLabelText('Message')).toHaveValue('draft A');
  });

  it('focuses the editable message field when the conversation changes', async () => {
    const view = render(
      <ChatComposer {...activeCapableProps} activeTurnId={null} conversationKey="gateway:a" />,
    );
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveFocus());
    screen.getByLabelText('Choose image attachments').focus();

    view.rerender(
      <ChatComposer {...activeCapableProps} activeTurnId={null} conversationKey="gateway:b" />,
    );
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveFocus());
  });

  it('retains a newer edit in the same conversation when an older attempt resolves', async () => {
    const acknowledged = deferred<void>();
    render(
      <ChatComposer
        {...activeCapableProps}
        activeTurnId={null}
        onSend={() => acknowledged.promise}
      />,
    );
    const textarea = screen.getByLabelText('Message');
    await userEvent.type(textarea, 'first');
    await userEvent.click(screen.getByLabelText('Send message'));
    await userEvent.type(textarea, ' plus newer');
    acknowledged.resolve(undefined);

    await waitFor(() => expect(textarea).toHaveValue('first plus newer'));
  });

  it.each([
    ['ordinary Send', false],
    ['Follow Up', true],
  ] as const)(
    'retains a replacement attachment when an older %s attempt resolves',
    async (_label, queued) => {
      const acknowledged = deferred<void>();
      render(
        <ChatComposer
          {...activeCapableProps}
          activeTurnId={queued ? 'run-1' : null}
          onSend={() => acknowledged.promise}
          onEnqueue={() => acknowledged.promise}
        />,
      );
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([1])], 'first.png', { type: 'image/png' }),
      );
      const firstPreview = (await screen.findByAltText('Attachment 1')).getAttribute('src');
      await userEvent.click(screen.getByLabelText('Send message'));
      if (queued) await userEvent.click(screen.getByRole('button', { name: 'Follow Up' }));

      await userEvent.click(screen.getByLabelText('Remove attachment 1'));
      await userEvent.upload(
        screen.getByLabelText('Attach images'),
        new File([new Uint8Array([2])], 'replacement.png', { type: 'image/png' }),
      );
      const replacement = await screen.findByAltText('Attachment 1');
      expect(replacement.getAttribute('src')).not.toBe(firstPreview);

      acknowledged.resolve(undefined);
      await waitFor(() => expect(screen.getByAltText('Attachment 1')).toBeInTheDocument());
      expect(screen.getByAltText('Attachment 1').getAttribute('src')).toBe(
        replacement.getAttribute('src'),
      );
    },
  );

  it('ignores Enter while an IME composition is active', () => {
    const onSend = vi.fn(async () => {});
    render(<ChatComposer {...activeCapableProps} activeTurnId={null} onSend={onSend} />);
    const textarea = screen.getByLabelText('Message');
    fireEvent.change(textarea, { target: { value: '入力中' } });
    fireEvent.keyDown(textarea, {
      key: 'Enter',
      keyCode: 229,
      nativeEvent: { isComposing: true },
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('keeps an active v1 composer disabled while exposing Stop only', () => {
    render(<ChatComposer {...activeCapableProps} queueCapable={false} />);
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.queryByLabelText('Send message')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cancel response')).toBeEnabled();
  });

  it('keeps a paused draft editable but prevents submission with explanatory status', async () => {
    render(<ChatComposer {...activeCapableProps} activeTurnId={null} queuePaused />);
    await userEvent.type(screen.getByLabelText('Message'), 'keep this draft');
    expect(screen.getByLabelText('Message')).toBeEnabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Follow Ups paused. Resume or remove them before sending.',
    );
  });

  it('does not enqueue when Follow Ups pause while the active-response chooser is open', async () => {
    const onEnqueue = vi.fn(async () => {});
    const view = render(<ChatComposer {...activeCapableProps} onEnqueue={onEnqueue} />);
    await userEvent.type(screen.getByLabelText('Message'), 'keep after pause');
    await userEvent.click(screen.getByLabelText('Send message'));
    const followUp = screen.getByRole('button', { name: 'Follow Up' });

    view.rerender(<ChatComposer {...activeCapableProps} queuePaused onEnqueue={onEnqueue} />);
    fireEvent.click(followUp);

    expect(onEnqueue).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('keep after pause');
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('shows and dismisses a conversation-scoped command issue', async () => {
    const onDismiss = vi.fn();
    render(
      <ChatComposer
        {...activeCapableProps}
        commandError="The active response changed. Try again."
        onDismissCommandError={onDismiss}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The active response changed. Try again.');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
