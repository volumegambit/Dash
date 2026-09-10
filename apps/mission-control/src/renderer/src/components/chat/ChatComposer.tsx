import type { MobileImage } from '@dash/mobile-contract';
import { Paperclip, Send, Square, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { composerKeyAction, insertNewlineAtSelection } from '../../routes/chat.helpers.js';

const ALLOWED_IMAGE_TYPES = new Set<MobileImage['mediaType']>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

export interface ChatInputPayload {
  text: string;
  images?: MobileImage[];
}

export interface ChatComposerAttempt {
  conversationKey: string;
  draftRevision: number;
  payload: ChatInputPayload;
}

export interface ChatComposerProps {
  conversationKey: string;
  activeTurnId: string | null;
  queueCapable: boolean;
  editable: boolean;
  queuePaused: boolean;
  placeholder: string;
  commandError?: string | null;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onDismissCommandError?(): void;
  onSend(attempt: ChatComposerAttempt): Promise<void>;
  onEnqueue(behavior: 'steer' | 'followUp', attempt: ChatComposerAttempt): Promise<void>;
  onStop(): void;
}

export interface ComposerAttachment extends MobileImage {
  id: string;
  preview: string;
}

interface ConversationDraft {
  text: string;
  images: ComposerAttachment[];
  revision: number;
}

function emptyDraft(): ConversationDraft {
  return { text: '', images: [], revision: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unable to send this message.';
}

export function payloadFromDraft(draft: {
  text: string;
  images: Pick<ComposerAttachment, 'mediaType' | 'data'>[];
}): ChatInputPayload {
  const images = draft.images.map(({ mediaType, data }) => ({ mediaType, data }));
  return {
    text: draft.text.trim(),
    ...(images.length > 0 ? { images } : {}),
  };
}

function payloadMatchesDraft(payload: ChatInputPayload, draft: ConversationDraft): boolean {
  if (payload.text !== draft.text.trim()) return false;
  const images = payload.images ?? [];
  if (images.length !== draft.images.length) return false;
  return images.every(
    (image, index) =>
      image.mediaType === draft.images[index]?.mediaType &&
      image.data === draft.images[index]?.data,
  );
}

export function filesFromPaste(event: ClipboardEvent<HTMLElement>): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export async function attachmentFromFile(file: File): Promise<ComposerAttachment> {
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read this image.'));
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    preview,
    mediaType: file.type as MobileImage['mediaType'],
    data: preview.split(',', 2)[1] ?? '',
  };
}

export function validateImageFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.has(file.type as MobileImage['mediaType'])) {
    return 'Unsupported image type. Use PNG, JPG, GIF, or WebP.';
  }
  if (file.size > MAX_IMAGE_BYTES) return 'Image must be under 5MB.';
  return null;
}

export function ChatComposer({
  conversationKey,
  activeTurnId,
  queueCapable,
  editable,
  queuePaused,
  placeholder,
  commandError,
  composerRef,
  onDismissCommandError,
  onSend,
  onEnqueue,
  onStop,
}: ChatComposerProps): JSX.Element {
  const draftsRef = useRef(new Map<string, ConversationDraft>());
  const pendingCountsRef = useRef(new Map<string, number>());
  const pendingImageReadsRef = useRef(new Map<string, number>());
  const localErrorsRef = useRef(new Map<string, string>());
  const imageErrorsRef = useRef(new Map<string, string>());
  const internalComposerRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = composerRef ?? internalComposerRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [chooserOpen, setChooserOpen] = useState(false);

  let draft = draftsRef.current.get(conversationKey);
  if (!draft) {
    draft = emptyDraft();
    draftsRef.current.set(conversationKey, draft);
  }

  const updateDraft = useCallback(
    (update: (current: ConversationDraft) => Pick<ConversationDraft, 'text' | 'images'>) => {
      const current = draftsRef.current.get(conversationKey) ?? emptyDraft();
      const next = update(current);
      draftsRef.current.set(conversationKey, {
        text: next.text,
        images: next.images,
        revision: current.revision + 1,
      });
      setRenderVersion((value) => value + 1);
    },
    [conversationKey],
  );

  const refocusComposer = useCallback(() => {
    textareaRef.current?.focus();
  }, [textareaRef]);

  const dismissChooser = useCallback(() => {
    setChooserOpen(false);
    refocusComposer();
  }, [refocusComposer]);

  useEffect(() => {
    if (!chooserOpen) return;
    const animationFrame = requestAnimationFrame(() => firstChoiceRef.current?.focus());
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismissChooser();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [chooserOpen, dismissChooser]);

  // Reading renderVersion makes the keyed ref store observable without
  // duplicating its contents into a second, conversation-unsafe state map.
  void renderVersion;
  const currentDraft = draftsRef.current.get(conversationKey) ?? draft;
  const hasPayload = Boolean(currentDraft.text.trim() || currentDraft.images.length > 0);
  const activeLegacy = Boolean(activeTurnId && !queueCapable);
  const inputEditable = editable && !activeLegacy;
  const pending = (pendingCountsRef.current.get(conversationKey) ?? 0) > 0;
  const pendingImageReads = pendingImageReadsRef.current.get(conversationKey) ?? 0;
  const localError = localErrorsRef.current.get(conversationKey) ?? null;
  const imageError = imageErrorsRef.current.get(conversationKey) ?? null;
  const canSubmit =
    inputEditable && !queuePaused && !pending && pendingImageReads === 0 && hasPayload;
  const showSend = !activeTurnId || queueCapable;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the keyed ref-backed draft must refocus when its prop key changes
  useEffect(() => {
    setChooserOpen(false);
    if (!inputEditable) return;
    const animationFrame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(animationFrame);
  }, [conversationKey, inputEditable]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref-backed text is observed through renderVersion and these scalar keys
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [conversationKey, currentDraft.text]);

  const captureAttempt = useCallback((): ChatComposerAttempt => {
    const current = draftsRef.current.get(conversationKey) ?? emptyDraft();
    return {
      conversationKey,
      draftRevision: current.revision,
      payload: payloadFromDraft(current),
    };
  }, [conversationKey]);

  const clearAcknowledgedAttempt = useCallback((attempt: ChatComposerAttempt) => {
    const current = draftsRef.current.get(attempt.conversationKey);
    if (
      !current ||
      current.revision !== attempt.draftRevision ||
      !payloadMatchesDraft(attempt.payload, current)
    ) {
      return;
    }
    draftsRef.current.set(attempt.conversationKey, {
      text: '',
      images: [],
      revision: current.revision + 1,
    });
    setRenderVersion((value) => value + 1);
  }, []);

  const deliver = useCallback(
    async (kind: 'send' | 'steer' | 'followUp') => {
      const attempt = captureAttempt();
      if (!attempt.payload.text && !attempt.payload.images?.length) return;
      const pendingCount = pendingCountsRef.current.get(attempt.conversationKey) ?? 0;
      pendingCountsRef.current.set(attempt.conversationKey, pendingCount + 1);
      localErrorsRef.current.delete(attempt.conversationKey);
      setRenderVersion((value) => value + 1);
      try {
        if (kind === 'send') await onSend(attempt);
        else await onEnqueue(kind, attempt);
        clearAcknowledgedAttempt(attempt);
      } catch (error) {
        localErrorsRef.current.set(attempt.conversationKey, errorMessage(error));
      } finally {
        const remaining = (pendingCountsRef.current.get(attempt.conversationKey) ?? 1) - 1;
        if (remaining > 0) pendingCountsRef.current.set(attempt.conversationKey, remaining);
        else pendingCountsRef.current.delete(attempt.conversationKey);
        setRenderVersion((value) => value + 1);
      }
    },
    [captureAttempt, clearAcknowledgedAttempt, onEnqueue, onSend],
  );

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (!canSubmit) return;
      if (activeTurnId && queueCapable) {
        setChooserOpen(true);
        return;
      }
      void deliver('send');
    },
    [activeTurnId, canSubmit, deliver, queueCapable],
  );

  const choose = useCallback(
    (behavior: 'steer' | 'followUp') => {
      if (!canSubmit || !activeTurnId || !queueCapable) {
        dismissChooser();
        return;
      }
      setChooserOpen(false);
      void deliver(behavior);
    },
    [activeTurnId, canSubmit, deliver, dismissChooser, queueCapable],
  );

  useEffect(() => {
    if (!chooserOpen || (activeTurnId && queueCapable && canSubmit)) return;
    dismissChooser();
  }, [activeTurnId, canSubmit, chooserOpen, dismissChooser, queueCapable]);

  const addImageFiles = useCallback(
    async (files: FileList | File[]) => {
      imageErrorsRef.current.delete(conversationKey);
      setRenderVersion((value) => value + 1);
      const candidates = Array.from(files);
      for (const file of candidates) {
        const validationError = validateImageFile(file);
        if (validationError) {
          imageErrorsRef.current.set(conversationKey, validationError);
          setRenderVersion((value) => value + 1);
          continue;
        }
        const current = draftsRef.current.get(conversationKey) ?? emptyDraft();
        const pendingReads = pendingImageReadsRef.current.get(conversationKey) ?? 0;
        if (current.images.length + pendingReads >= MAX_IMAGES) {
          imageErrorsRef.current.set(conversationKey, 'Maximum 4 images per message.');
          setRenderVersion((value) => value + 1);
          break;
        }
        pendingImageReadsRef.current.set(conversationKey, pendingReads + 1);
        setRenderVersion((value) => value + 1);
        try {
          const attachment = await attachmentFromFile(file);
          const latest = draftsRef.current.get(conversationKey) ?? emptyDraft();
          if (latest.images.length >= MAX_IMAGES) {
            imageErrorsRef.current.set(conversationKey, 'Maximum 4 images per message.');
          } else {
            updateDraft((draft) => ({ ...draft, images: [...draft.images, attachment] }));
          }
        } catch (error) {
          imageErrorsRef.current.set(conversationKey, errorMessage(error));
        } finally {
          const remaining = (pendingImageReadsRef.current.get(conversationKey) ?? 1) - 1;
          if (remaining > 0) pendingImageReadsRef.current.set(conversationKey, remaining);
          else pendingImageReadsRef.current.delete(conversationKey);
          setRenderVersion((value) => value + 1);
        }
      }
    },
    [conversationKey, updateDraft],
  );

  const onTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      const action = composerKeyAction(event.key, event.shiftKey, event.metaKey || event.ctrlKey);
      if (event.key === 'Tab' && action === 'newline') {
        event.preventDefault();
        const field = event.currentTarget;
        const next = insertNewlineAtSelection(
          field.value,
          field.selectionStart,
          field.selectionEnd,
        );
        updateDraft((current) => ({ ...current, text: next.value }));
        requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
        return;
      }
      if (event.key === 'Enter' && action === 'send') {
        event.preventDefault();
        submit();
      }
    },
    [submit, updateDraft],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = filesFromPaste(event);
      if (files.length > 0) void addImageFiles(files);
    },
    [addImageFiles],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (event.dataTransfer.files.length > 0) void addImageFiles(event.dataTransfer.files);
    },
    [addImageFiles],
  );

  const displayedError = commandError || localError;

  return (
    <div className="bg-surface border-t border-border px-6 py-4 shrink-0">
      <div className="flex flex-col gap-2">
        {currentDraft.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {currentDraft.images.map((image, index) => (
              <div key={image.id} className="relative">
                <img
                  src={image.preview}
                  alt={`Attachment ${index + 1}`}
                  className="h-16 w-16 border border-border object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove attachment ${index + 1}`}
                  onClick={() => {
                    updateDraft((current) => ({
                      ...current,
                      images: current.images.filter((item) => item.id !== image.id),
                    }));
                    imageErrorsRef.current.delete(conversationKey);
                  }}
                  disabled={!inputEditable}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-900 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {imageError && (
          <p className="text-xs text-red" role="alert">
            {imageError}
          </p>
        )}
        {displayedError && (
          <div className="flex items-center justify-between gap-3 text-xs text-red" role="alert">
            <span>{displayedError}</span>
            <button
              type="button"
              onClick={() => {
                if (commandError) onDismissCommandError?.();
                else {
                  localErrorsRef.current.delete(conversationKey);
                  setRenderVersion((value) => value + 1);
                }
              }}
              className="border border-red/40 px-2 py-1 hover:bg-red-900/30"
            >
              Dismiss
            </button>
          </div>
        )}
        {queuePaused && (
          <output className="block text-xs text-yellow-200">
            Follow Ups paused. Resume or remove them before sending.
          </output>
        )}
        <form
          className="flex items-end gap-3"
          onSubmit={submit}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          <textarea
            ref={textareaRef}
            aria-label="Message"
            rows={1}
            value={currentDraft.text}
            onChange={(event) =>
              updateDraft((current) => ({ ...current, text: event.target.value }))
            }
            onKeyDown={onTextareaKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={!inputEditable}
            className="min-h-11 flex-1 resize-none border border-border bg-[#141414] px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            aria-label="Attach images"
            disabled={!inputEditable}
            onChange={(event) => {
              if (event.target.files) void addImageFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Choose image attachments"
            title="Attach images"
            onClick={() => fileInputRef.current?.click()}
            disabled={!inputEditable}
            className="shrink-0 border border-border p-2.5 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
          >
            <Paperclip size={16} />
          </button>
          {showSend && (
            <button
              type="submit"
              aria-label="Send message"
              disabled={!canSubmit}
              className="shrink-0 bg-accent p-2.5 text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              <Send size={16} />
            </button>
          )}
          {activeTurnId && (
            <button
              type="button"
              aria-label="Cancel response"
              onClick={onStop}
              className="shrink-0 bg-red-900/50 p-2.5 text-red transition-colors hover:bg-red-900/70"
            >
              <Square size={16} />
            </button>
          )}
        </form>
      </div>

      {chooserOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) dismissChooser();
          }}
        >
          <dialog
            open
            aria-modal="true"
            aria-labelledby="active-response-chooser-title"
            className="w-full max-w-md border border-border bg-surface p-4 shadow-xl"
          >
            <h2 id="active-response-chooser-title" className="mb-3 text-sm font-semibold">
              A response is in progress
            </h2>
            <div className="grid gap-2">
              <button
                ref={firstChoiceRef}
                type="button"
                aria-label="Steer"
                aria-describedby="active-response-steer-description"
                onClick={() => choose('steer')}
                disabled={!canSubmit}
                className="flex flex-col border border-border p-3 text-left hover:border-accent hover:bg-sidebar-hover"
              >
                <strong>Steer</strong>
                <span id="active-response-steer-description" className="text-xs text-muted">
                  Guide the response in progress
                </span>
              </button>
              <button
                type="button"
                aria-label="Follow Up"
                aria-describedby="active-response-follow-up-description"
                onClick={() => choose('followUp')}
                disabled={!canSubmit}
                className="flex flex-col border border-border p-3 text-left hover:border-accent hover:bg-sidebar-hover"
              >
                <strong>Follow Up</strong>
                <span id="active-response-follow-up-description" className="text-xs text-muted">
                  Send after this response finishes
                </span>
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
}
