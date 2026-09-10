import type { MobileV2PendingInput } from '@dash/mobile-contract-v2';
import { Paperclip, Pencil, Trash2, X } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type ChatInputPayload,
  type ComposerAttachment,
  attachmentFromFile,
  payloadFromDraft,
  validateImageFile,
} from './ChatComposer.js';

export interface FollowUpQueueProps {
  conversationKey: string;
  items: MobileV2PendingInput[];
  paused: boolean;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onEdit(inputId: string, revision: number, payload: ChatInputPayload): Promise<void>;
  onRemove(inputId: string, revision: number): Promise<void>;
  onResume(): Promise<void>;
}

function attachmentFromMobileImage(
  image: NonNullable<MobileV2PendingInput['images']>[number],
  index: number,
) {
  return {
    ...image,
    id: `existing-${index}-${image.mediaType}-${image.data.slice(0, 12)}`,
    preview: `data:${image.mediaType};base64,${image.data}`,
  } satisfies ComposerAttachment;
}

function messageFromError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Unable to update this Follow Up.';
}

export function FollowUpQueue({
  conversationKey,
  items,
  paused,
  composerRef,
  onEdit,
  onRemove,
  onResume,
}: FollowUpQueueProps): JSX.Element | null {
  const visibleItems = useMemo(
    () =>
      items
        .filter(
          (item) => item.kind === 'follow_up' && ['queued', 'delivering'].includes(item.state),
        )
        .toSorted((left, right) => left.enqueueOrder - right.enqueueOrder),
    [items],
  );
  const actionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeConversationKeyRef = useRef(conversationKey);
  const editingIdRef = useRef<string | null>(null);
  const editorSessionTokenRef = useRef<symbol | null>(null);
  const editorRevisionRef = useRef(0);
  const editorVersionRef = useRef(0);
  const editorImagesRef = useRef<ComposerAttachment[]>([]);
  const pendingImageReadsRef = useRef(0);
  const pendingEditTokensRef = useRef(new Map<string, symbol>());
  const pendingRemoveTokensRef = useRef(new Map<string, symbol>());
  const pendingResumeTokenRef = useRef<symbol | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [editorImages, setEditorImages] = useState<ComposerAttachment[]>([]);
  const [editorRevision, setEditorRevision] = useState(0);
  const [pendingImageReads, setPendingImageReads] = useState(0);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(() => new Set());
  const [pendingResume, setPendingResume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useLayoutEffect(() => {
    if (activeConversationKeyRef.current === conversationKey) return;
    activeConversationKeyRef.current = conversationKey;
    actionRefs.current = {};
    editingIdRef.current = null;
    editorSessionTokenRef.current = null;
    editorRevisionRef.current = 0;
    editorVersionRef.current += 1;
    editorImagesRef.current = [];
    pendingImageReadsRef.current = 0;
    pendingEditTokensRef.current = new Map();
    pendingRemoveTokensRef.current = new Map();
    pendingResumeTokenRef.current = null;
    setEditingId(null);
    setEditorText('');
    setEditorImages([]);
    setEditorRevision(0);
    setPendingImageReads(0);
    setPendingEditIds(new Set());
    setPendingRemoveIds(new Set());
    setPendingResume(false);
    setError(null);
    setImageError(null);
  }, [conversationKey]);

  useEffect(() => {
    if (!editingId) return;
    const current = visibleItems.find((item) => item.inputId === editingId);
    if (current?.state === 'delivering') {
      editingIdRef.current = null;
      editorSessionTokenRef.current = null;
      editorVersionRef.current += 1;
      pendingImageReadsRef.current = 0;
      setPendingImageReads(0);
      setEditingId(null);
      return;
    }
    if (current && current.revision !== editorRevisionRef.current) {
      editorRevisionRef.current = current.revision;
      editorVersionRef.current += 1;
      setEditorRevision(current.revision);
    }
  }, [editingId, visibleItems]);

  if (visibleItems.length === 0 && !paused) return null;

  const beginEdit = (item: MobileV2PendingInput): void => {
    if (
      pendingEditTokensRef.current.has(item.inputId) ||
      pendingRemoveTokensRef.current.has(item.inputId)
    ) {
      return;
    }
    editingIdRef.current = item.inputId;
    editorSessionTokenRef.current = Symbol(`${conversationKey}:${item.inputId}`);
    editorVersionRef.current += 1;
    setEditingId(item.inputId);
    setEditorText(item.text);
    const images = (item.images ?? []).map(attachmentFromMobileImage);
    editorImagesRef.current = images;
    pendingImageReadsRef.current = 0;
    setPendingImageReads(0);
    setEditorImages(images);
    editorRevisionRef.current = item.revision;
    setEditorRevision(item.revision);
    setError(null);
    setImageError(null);
  };

  const saveEdit = async (): Promise<void> => {
    if (!editingId || (!editorText.trim() && editorImages.length === 0)) return;
    if (
      pendingEditTokensRef.current.has(editingId) ||
      pendingRemoveTokensRef.current.has(editingId)
    ) {
      return;
    }
    const inputId = editingId;
    const revision = editorRevision;
    const editorVersion = editorVersionRef.current;
    const operationConversationKey = conversationKey;
    const operationToken = Symbol(inputId);
    const payload = payloadFromDraft({ text: editorText, images: editorImages });
    pendingEditTokensRef.current = new Map(pendingEditTokensRef.current).set(
      inputId,
      operationToken,
    );
    setPendingEditIds(new Set(pendingEditTokensRef.current.keys()));
    setError(null);
    try {
      await onEdit(inputId, revision, payload);
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingEditTokensRef.current.get(inputId) === operationToken &&
        editingIdRef.current === inputId &&
        editorVersionRef.current === editorVersion
      ) {
        editingIdRef.current = null;
        editorSessionTokenRef.current = null;
        editorVersionRef.current += 1;
        setEditingId(null);
      }
    } catch (caught) {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingEditTokensRef.current.get(inputId) === operationToken &&
        editingIdRef.current === inputId &&
        editorVersionRef.current === editorVersion
      ) {
        setError(messageFromError(caught));
      }
    } finally {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingEditTokensRef.current.get(inputId) === operationToken
      ) {
        pendingEditTokensRef.current = new Map(pendingEditTokensRef.current);
        pendingEditTokensRef.current.delete(inputId);
        setPendingEditIds(new Set(pendingEditTokensRef.current.keys()));
      }
    }
  };

  const addEditorImages = async (files: FileList): Promise<void> => {
    const operationConversationKey = conversationKey;
    const operationEditingId = editingIdRef.current;
    const editorSessionToken = editorSessionTokenRef.current;
    if (!operationEditingId || !editorSessionToken) return;
    const candidates = Array.from(files);
    if (candidates.length === 0) return;
    editorVersionRef.current += 1;

    const editorSessionIsCurrent = (): boolean =>
      activeConversationKeyRef.current === operationConversationKey &&
      editingIdRef.current === operationEditingId &&
      editorSessionTokenRef.current === editorSessionToken;

    setImageError(null);
    for (const file of candidates) {
      if (!editorSessionIsCurrent()) return;
      const validationError = validateImageFile(file);
      if (validationError) {
        setImageError(validationError);
        continue;
      }
      if (editorImagesRef.current.length + pendingImageReadsRef.current >= 4) {
        setImageError('Maximum 4 images per message.');
        break;
      }
      pendingImageReadsRef.current += 1;
      setPendingImageReads(pendingImageReadsRef.current);
      try {
        const attachment = await attachmentFromFile(file);
        if (!editorSessionIsCurrent()) return;
        if (editorImagesRef.current.length >= 4) {
          setImageError('Maximum 4 images per message.');
          break;
        }
        const nextImages = [...editorImagesRef.current, attachment];
        editorImagesRef.current = nextImages;
        editorVersionRef.current += 1;
        setEditorImages(nextImages);
      } catch (caught) {
        if (editorSessionIsCurrent()) setImageError(messageFromError(caught));
      } finally {
        if (editorSessionIsCurrent()) {
          pendingImageReadsRef.current = Math.max(0, pendingImageReadsRef.current - 1);
          setPendingImageReads(pendingImageReadsRef.current);
        }
      }
    }
  };

  const remove = async (item: MobileV2PendingInput, index: number): Promise<void> => {
    if (
      pendingRemoveTokensRef.current.has(item.inputId) ||
      pendingEditTokensRef.current.has(item.inputId)
    ) {
      return;
    }
    const operationToken = Symbol(item.inputId);
    pendingRemoveTokensRef.current = new Map(pendingRemoveTokensRef.current).set(
      item.inputId,
      operationToken,
    );
    setPendingRemoveIds(new Set(pendingRemoveTokensRef.current.keys()));
    setError(null);
    const operationConversationKey = conversationKey;
    try {
      await onRemove(item.inputId, item.revision);
      if (
        activeConversationKeyRef.current !== operationConversationKey ||
        pendingRemoveTokensRef.current.get(item.inputId) !== operationToken
      ) {
        return;
      }
      const next = visibleItems[index + 1];
      if (
        next &&
        !pendingEditTokensRef.current.has(next.inputId) &&
        !pendingRemoveTokensRef.current.has(next.inputId)
      ) {
        actionRefs.current[next.inputId]?.focus();
      } else {
        composerRef?.current?.focus();
      }
    } catch (caught) {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingRemoveTokensRef.current.get(item.inputId) === operationToken
      ) {
        setError(messageFromError(caught));
      }
    } finally {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingRemoveTokensRef.current.get(item.inputId) === operationToken
      ) {
        pendingRemoveTokensRef.current = new Map(pendingRemoveTokensRef.current);
        pendingRemoveTokensRef.current.delete(item.inputId);
        setPendingRemoveIds(new Set(pendingRemoveTokensRef.current.keys()));
      }
    }
  };

  return (
    <section aria-label="Follow Up queue" className="border-t border-border bg-surface px-6 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Follow Ups ({visibleItems.length})
        </h2>
        {paused && (
          <output className="flex items-center gap-2">
            <span className="text-xs text-yellow-200">Follow Ups paused</span>
            <button
              type="button"
              disabled={pendingResume}
              onClick={() => {
                const operationConversationKey = conversationKey;
                const operationToken = Symbol('resume');
                pendingResumeTokenRef.current = operationToken;
                setPendingResume(true);
                setError(null);
                void onResume()
                  .catch((caught) => {
                    if (
                      activeConversationKeyRef.current === operationConversationKey &&
                      pendingResumeTokenRef.current === operationToken
                    ) {
                      setError(messageFromError(caught));
                    }
                  })
                  .finally(() => {
                    if (
                      activeConversationKeyRef.current === operationConversationKey &&
                      pendingResumeTokenRef.current === operationToken
                    ) {
                      pendingResumeTokenRef.current = null;
                      setPendingResume(false);
                    }
                  });
              }}
              className="border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
            >
              Resume Follow Ups
            </button>
          </output>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-2 text-xs text-red">
          {error}
        </p>
      )}
      <div className="grid gap-2">
        {visibleItems.map((item, index) => {
          const positionLabel = `Follow Up, position ${index + 1} of ${visibleItems.length}`;
          const editing = editingId === item.inputId;
          const pendingEdit = pendingEditIds.has(item.inputId);
          const pendingRemove = pendingRemoveIds.has(item.inputId);
          const pendingItem = pendingEdit || pendingRemove;
          return (
            <article
              key={item.inputId}
              aria-label={positionLabel}
              data-follow-up-id={item.inputId}
              className={`border border-border bg-[#141414] p-3 ${
                reducedMotion ? '' : 'transition-colors'
              }`}
            >
              {editing ? (
                <div className="grid gap-2">
                  <textarea
                    aria-label={`Edit Follow Up text, position ${index + 1} of ${visibleItems.length}`}
                    value={editorText}
                    onChange={(event) => {
                      editorVersionRef.current += 1;
                      setEditorText(event.target.value);
                    }}
                    rows={2}
                    className="w-full resize-none border border-border bg-background p-2 text-sm focus:border-accent focus:outline-none"
                  />
                  {editorImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {editorImages.map((image, imageIndex) => (
                        <div key={image.id} className="relative">
                          <img
                            src={image.preview}
                            alt={`Editor attachment ${imageIndex + 1}`}
                            className="h-14 w-14 border border-border object-cover"
                          />
                          <button
                            type="button"
                            aria-label={`Remove editor attachment ${imageIndex + 1}`}
                            onClick={() => {
                              const nextImages = editorImagesRef.current.filter(
                                (candidate) => candidate.id !== image.id,
                              );
                              editorImagesRef.current = nextImages;
                              editorVersionRef.current += 1;
                              setEditorImages(nextImages);
                            }}
                            disabled={pendingEdit}
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-900 text-white"
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {imageError && (
                    <p role="alert" className="text-xs text-red">
                      {imageError}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="cursor-pointer border border-border p-2 text-muted hover:text-foreground">
                      <Paperclip size={14} />
                      <span className="sr-only">Attach images to Follow Up</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        multiple
                        className="hidden"
                        aria-label="Attach images to Follow Up"
                        onChange={(event) => {
                          if (event.target.files) void addEditorImages(event.target.files);
                          event.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void saveEdit()}
                      disabled={
                        pendingEdit ||
                        pendingImageReads > 0 ||
                        (!editorText.trim() && editorImages.length === 0)
                      }
                      className="bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
                    >
                      Save Follow Up
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        editingIdRef.current = null;
                        editorSessionTokenRef.current = null;
                        editorVersionRef.current += 1;
                        pendingImageReadsRef.current = 0;
                        setPendingImageReads(0);
                        setEditingId(null);
                      }}
                      disabled={pendingEdit}
                      className="border border-border px-3 py-1.5 text-xs"
                    >
                      Cancel edit
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-wrap text-sm">{item.text}</p>
                    {item.images && item.images.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.images.map((image, imageIndex) => (
                          <img
                            key={`${image.mediaType}-${image.data.slice(0, 12)}-${imageIndex}`}
                            src={`data:${image.mediaType};base64,${image.data}`}
                            alt={`Follow Up attachment ${imageIndex + 1}`}
                            className="h-12 w-12 border border-border object-cover"
                          />
                        ))}
                      </div>
                    )}
                    {item.state === 'delivering' && (
                      <p className="mt-1 text-xs text-muted">Delivering…</p>
                    )}
                  </div>
                  {item.state !== 'delivering' && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        ref={(element) => {
                          actionRefs.current[item.inputId] = element;
                        }}
                        type="button"
                        aria-label={`Edit ${positionLabel}`}
                        onClick={() => beginEdit(item)}
                        disabled={pendingItem}
                        className="border border-border p-2 text-muted hover:text-foreground disabled:opacity-50"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${positionLabel}`}
                        disabled={pendingItem}
                        onClick={() => void remove(item, index)}
                        className="border border-border p-2 text-muted hover:text-red disabled:opacity-50"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
