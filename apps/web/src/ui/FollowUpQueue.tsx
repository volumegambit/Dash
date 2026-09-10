import type { MobileImage } from '@dash/mobile-contract';
import type { MobileV2PendingInput } from '@dash/mobile-contract-v2';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  IMAGE_MEDIA_TYPES,
  type PendingImageAttachment,
  readImageFile,
  validateImageFiles,
} from './attachments.js';

export interface FollowUpQueueProps {
  conversationKey: string;
  items: MobileV2PendingInput[];
  paused: boolean;
  composerRef?: RefObject<HTMLTextAreaElement | null>;
  onEdit(inputId: string, revision: number, text: string, images?: MobileImage[]): Promise<void>;
  onRemove(inputId: string, revision: number): Promise<void>;
  onResume(): Promise<void>;
}

interface ImageReservation {
  conversationKey: string;
  inputId: string;
  editorSession: symbol;
  bytes: number;
}

function base64ByteLength(data: string): number {
  const value = data.replace(/\s/g, '');
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function attachmentFromMobileImage(
  image: NonNullable<MobileV2PendingInput['images']>[number],
  index: number,
): PendingImageAttachment {
  return {
    ...image,
    id: `existing-${index}-${image.mediaType}-${image.data.slice(0, 12)}`,
    preview: `data:${image.mediaType};base64,${image.data}`,
    bytes: base64ByteLength(image.data),
  };
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
}: FollowUpQueueProps): ReactNode {
  const visibleItems = useMemo(
    () =>
      items
        .filter(
          (item) =>
            item.kind === 'follow_up' && (item.state === 'queued' || item.state === 'delivering'),
        )
        .toSorted(
          (left, right) =>
            left.enqueueOrder - right.enqueueOrder || left.inputId.localeCompare(right.inputId),
        ),
    [items],
  );
  const actionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const editorTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeConversationKeyRef = useRef(conversationKey);
  const editingIdRef = useRef<string | null>(null);
  const editorConversationKeyRef = useRef<string | null>(null);
  const editorExitFocusRef = useRef<{ conversationKey: string; inputId: string } | null>(null);
  const editorSessionRef = useRef<symbol | null>(null);
  const editorRevisionRef = useRef(0);
  const editorVersionRef = useRef(0);
  const editorImagesRef = useRef<PendingImageAttachment[]>([]);
  const imageReservationsRef = useRef(new Map<symbol, ImageReservation>());
  const pendingEditTokensRef = useRef(new Map<string, symbol>());
  const pendingRemoveTokensRef = useRef(new Map<string, symbol>());
  const pendingResumeTokenRef = useRef<symbol | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [editorImages, setEditorImages] = useState<PendingImageAttachment[]>([]);
  const [editorRevision, setEditorRevision] = useState(0);
  const [pendingImageReads, setPendingImageReads] = useState(0);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(() => new Set());
  const [pendingResume, setPendingResume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (activeConversationKeyRef.current === conversationKey) return;
    activeConversationKeyRef.current = conversationKey;
    actionRefs.current = {};
    editingIdRef.current = null;
    editorConversationKeyRef.current = null;
    editorExitFocusRef.current = null;
    editorSessionRef.current = null;
    editorRevisionRef.current = 0;
    editorVersionRef.current += 1;
    editorImagesRef.current = [];
    imageReservationsRef.current = new Map();
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

  useLayoutEffect(() => {
    if (editingId && editorConversationKeyRef.current === conversationKey) {
      editorTextareaRef.current?.focus();
      return;
    }

    const target = editorExitFocusRef.current;
    if (!target || target.conversationKey !== conversationKey || editingId !== null) return;
    editorExitFocusRef.current = null;
    const editAction = actionRefs.current[target.inputId];
    if (editAction?.isConnected && !editAction.disabled) editAction.focus();
    else composerRef?.current?.focus();
  }, [composerRef, conversationKey, editingId]);

  useEffect(() => {
    if (!editingId) return;
    const current = visibleItems.find((item) => item.inputId === editingId);
    if (!current || current.state === 'delivering') {
      editorExitFocusRef.current = { conversationKey, inputId: editingId };
      editingIdRef.current = null;
      editorConversationKeyRef.current = null;
      editorSessionRef.current = null;
      editorVersionRef.current += 1;
      editorImagesRef.current = [];
      setPendingImageReads(0);
      setEditingId(null);
      setEditorImages([]);
      return;
    }
    if (current.revision !== editorRevisionRef.current) {
      editorRevisionRef.current = current.revision;
      editorVersionRef.current += 1;
      setEditorRevision(current.revision);
    }
  }, [conversationKey, editingId, visibleItems]);

  if (visibleItems.length === 0 && !paused) return null;

  const reservationsFor = (
    operationConversationKey: string,
    operationEditingId: string,
    editorSession: symbol,
  ): ImageReservation[] =>
    Array.from(imageReservationsRef.current.values()).filter(
      (reservation) =>
        reservation.conversationKey === operationConversationKey &&
        reservation.inputId === operationEditingId &&
        reservation.editorSession === editorSession,
    );

  const editorSessionIsCurrent = (
    operationConversationKey: string,
    operationEditingId: string,
    editorSession: symbol,
  ): boolean =>
    activeConversationKeyRef.current === operationConversationKey &&
    editingIdRef.current === operationEditingId &&
    editorSessionRef.current === editorSession;

  const beginEdit = (item: MobileV2PendingInput): void => {
    if (
      pendingEditTokensRef.current.has(item.inputId) ||
      pendingRemoveTokensRef.current.has(item.inputId)
    ) {
      return;
    }
    const images = (item.images ?? []).map(attachmentFromMobileImage);
    editingIdRef.current = item.inputId;
    editorConversationKeyRef.current = conversationKey;
    editorSessionRef.current = Symbol(`${conversationKey}:${item.inputId}`);
    editorRevisionRef.current = item.revision;
    editorVersionRef.current += 1;
    editorImagesRef.current = images;
    setEditingId(item.inputId);
    setEditorText(item.text);
    setEditorImages(images);
    setEditorRevision(item.revision);
    setPendingImageReads(0);
    setError(null);
    setImageError(null);
  };

  const closeEditor = (): void => {
    const inputId = editingIdRef.current;
    if (inputId) editorExitFocusRef.current = { conversationKey, inputId };
    editingIdRef.current = null;
    editorConversationKeyRef.current = null;
    editorSessionRef.current = null;
    editorVersionRef.current += 1;
    editorImagesRef.current = [];
    setEditingId(null);
    setEditorImages([]);
    setPendingImageReads(0);
    setImageError(null);
  };

  const saveEdit = async (): Promise<void> => {
    const inputId = editingIdRef.current;
    const editorSession = editorSessionRef.current;
    if (
      !inputId ||
      !editorSession ||
      (!editorText.trim() && editorImagesRef.current.length === 0)
    ) {
      return;
    }
    if (
      pendingEditTokensRef.current.has(inputId) ||
      pendingRemoveTokensRef.current.has(inputId) ||
      reservationsFor(conversationKey, inputId, editorSession).length > 0
    ) {
      return;
    }

    const operationConversationKey = conversationKey;
    const revision = editorRevision;
    const editorVersion = editorVersionRef.current;
    const operationToken = Symbol(inputId);
    const text = editorText.trim();
    const images = editorImagesRef.current.map(({ mediaType, data }) => ({ mediaType, data }));
    pendingEditTokensRef.current = new Map(pendingEditTokensRef.current).set(
      inputId,
      operationToken,
    );
    setPendingEditIds(new Set(pendingEditTokensRef.current.keys()));
    setError(null);
    try {
      await onEdit(inputId, revision, text, images.length > 0 ? images : undefined);
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingEditTokensRef.current.get(inputId) === operationToken &&
        editingIdRef.current === inputId &&
        editorSessionRef.current === editorSession &&
        editorVersionRef.current === editorVersion
      ) {
        closeEditor();
      }
    } catch (caught) {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingEditTokensRef.current.get(inputId) === operationToken &&
        editingIdRef.current === inputId &&
        editorSessionRef.current === editorSession &&
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

  const addEditorImages = async (files: FileList | File[]): Promise<void> => {
    const candidates = Array.from(files);
    if (candidates.length === 0) return;

    const operationConversationKey = conversationKey;
    const operationEditingId = editingIdRef.current;
    const editorSession = editorSessionRef.current;
    if (!operationEditingId || !editorSession) return;

    // Selection itself is an editor mutation. A Save that was already in
    // flight must not close this session before these bytes finish reading.
    editorVersionRef.current += 1;
    if (!editorSessionIsCurrent(operationConversationKey, operationEditingId, editorSession)) {
      return;
    }

    const reserved = reservationsFor(operationConversationKey, operationEditingId, editorSession);
    const { accepted, error: validationError } = validateImageFiles(
      [...editorImagesRef.current, ...reserved],
      candidates,
    );
    setImageError(validationError);
    if (accepted.length === 0) return;

    const reads = accepted.map((file) => {
      const readToken = Symbol(file.name);
      imageReservationsRef.current.set(readToken, {
        conversationKey: operationConversationKey,
        inputId: operationEditingId,
        editorSession,
        bytes: file.size,
      });
      return { file, readToken };
    });
    setPendingImageReads(
      reservationsFor(operationConversationKey, operationEditingId, editorSession).length,
    );

    await Promise.allSettled(
      reads.map(async ({ file, readToken }) => {
        try {
          const attachment = await readImageFile(file);
          if (
            !imageReservationsRef.current.has(readToken) ||
            !editorSessionIsCurrent(operationConversationKey, operationEditingId, editorSession)
          ) {
            return;
          }
          const recheck = validateImageFiles(editorImagesRef.current, [file]);
          if (recheck.accepted.length === 0) {
            setImageError(recheck.error);
            return;
          }
          const nextImages = [...editorImagesRef.current, attachment];
          editorImagesRef.current = nextImages;
          editorVersionRef.current += 1;
          setEditorImages(nextImages);
        } catch (caught) {
          if (editorSessionIsCurrent(operationConversationKey, operationEditingId, editorSession)) {
            setImageError(messageFromError(caught));
          }
        } finally {
          const reservation = imageReservationsRef.current.get(readToken);
          if (
            reservation?.conversationKey === operationConversationKey &&
            reservation.inputId === operationEditingId &&
            reservation.editorSession === editorSession
          ) {
            imageReservationsRef.current.delete(readToken);
          }
          if (editorSessionIsCurrent(operationConversationKey, operationEditingId, editorSession)) {
            setPendingImageReads(
              reservationsFor(operationConversationKey, operationEditingId, editorSession).length,
            );
          }
        }
      }),
    );
  };

  const remove = async (item: MobileV2PendingInput, index: number): Promise<void> => {
    if (
      pendingRemoveTokensRef.current.has(item.inputId) ||
      pendingEditTokensRef.current.has(item.inputId)
    ) {
      return;
    }
    const operationConversationKey = conversationKey;
    const operationToken = Symbol(item.inputId);
    const nextInputId = visibleItems[index + 1]?.inputId;
    pendingRemoveTokensRef.current = new Map(pendingRemoveTokensRef.current).set(
      item.inputId,
      operationToken,
    );
    setPendingRemoveIds(new Set(pendingRemoveTokensRef.current.keys()));
    setError(null);
    try {
      await onRemove(item.inputId, item.revision);
      if (
        activeConversationKeyRef.current !== operationConversationKey ||
        pendingRemoveTokensRef.current.get(item.inputId) !== operationToken
      ) {
        return;
      }
      const nextAction = nextInputId ? actionRefs.current[nextInputId] : null;
      if (
        nextAction?.isConnected &&
        !pendingEditTokensRef.current.has(nextInputId ?? '') &&
        !pendingRemoveTokensRef.current.has(nextInputId ?? '')
      ) {
        nextAction.focus();
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

  const resume = async (): Promise<void> => {
    if (pendingResumeTokenRef.current) return;
    const operationConversationKey = conversationKey;
    const operationToken = Symbol('resume');
    pendingResumeTokenRef.current = operationToken;
    setPendingResume(true);
    setError(null);
    try {
      await onResume();
    } catch (caught) {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingResumeTokenRef.current === operationToken
      ) {
        setError(messageFromError(caught));
      }
    } finally {
      if (
        activeConversationKeyRef.current === operationConversationKey &&
        pendingResumeTokenRef.current === operationToken
      ) {
        pendingResumeTokenRef.current = null;
        setPendingResume(false);
      }
    }
  };

  return (
    <section className="follow-up-queue" aria-label="Follow Up queue">
      <div className="follow-up-queue-header">
        <h2>Follow Ups ({visibleItems.length})</h2>
        {paused && (
          <output className="follow-up-queue-status">
            <span>Follow Ups paused</span>
            <button type="button" disabled={pendingResume} onClick={() => void resume()}>
              Resume Follow Ups
            </button>
          </output>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="follow-up-list">
        {visibleItems.map((item, index) => {
          const positionLabel = `Follow Up, position ${index + 1} of ${visibleItems.length}`;
          const editing = editingId === item.inputId;
          const pendingEdit = pendingEditIds.has(item.inputId);
          const pendingRemove = pendingRemoveIds.has(item.inputId);
          const pendingItem = pendingEdit || pendingRemove;
          return (
            <article
              key={item.inputId}
              className="follow-up-card"
              aria-label={positionLabel}
              aria-busy={pendingItem || undefined}
              data-follow-up-id={item.inputId}
            >
              <div className="follow-up-card-heading" aria-hidden="true">
                <span>Follow Up</span>
                <span>
                  {index + 1} of {visibleItems.length}
                </span>
              </div>
              {editing ? (
                <div className="follow-up-editor">
                  <textarea
                    ref={editorTextareaRef}
                    aria-label={`Edit Follow Up text, position ${index + 1} of ${visibleItems.length}`}
                    rows={2}
                    value={editorText}
                    onChange={(event) => {
                      editorVersionRef.current += 1;
                      setEditorText(event.target.value);
                    }}
                  />
                  {editorImages.length > 0 && (
                    <ul
                      className="app-composer-attachments follow-up-editor-attachments"
                      aria-label="Follow Up editor images"
                    >
                      {editorImages.map((image, imageIndex) => (
                        <li key={image.id} className="app-composer-attachment">
                          <img
                            className="app-composer-attachment-image"
                            src={image.preview}
                            alt={`Editor attachment ${imageIndex + 1}`}
                          />
                          <button
                            type="button"
                            className="app-composer-attachment-remove"
                            aria-label={`Remove editor attachment ${imageIndex + 1}`}
                            disabled={pendingEdit}
                            onClick={() => {
                              const nextImages = editorImagesRef.current.filter(
                                (candidate) => candidate.id !== image.id,
                              );
                              editorImagesRef.current = nextImages;
                              editorVersionRef.current += 1;
                              setEditorImages(nextImages);
                              setImageError(null);
                            }}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {imageError && <p role="alert">{imageError}</p>}
                  <div className="follow-up-editor-actions">
                    <label className="follow-up-attach">
                      <span>Attach images</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={IMAGE_MEDIA_TYPES.join(',')}
                        multiple
                        aria-label="Attach images to Follow Up"
                        className="app-composer-file-input"
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
                    >
                      Save Follow Up
                    </button>
                    <button type="button" disabled={pendingEdit} onClick={closeEditor}>
                      Cancel edit
                    </button>
                  </div>
                </div>
              ) : (
                <div className="follow-up-card-content">
                  <div className="follow-up-card-body">
                    <p>{item.text}</p>
                    {item.images && item.images.length > 0 && (
                      <div className="follow-up-card-attachments">
                        {item.images.map((image, imageIndex) => (
                          <img
                            key={`${image.mediaType}-${image.data.slice(0, 12)}-${imageIndex}`}
                            src={`data:${image.mediaType};base64,${image.data}`}
                            alt={`Follow Up attachment ${imageIndex + 1}`}
                          />
                        ))}
                      </div>
                    )}
                    {item.state === 'delivering' && <p>Delivering…</p>}
                  </div>
                  {item.state !== 'delivering' && (
                    <div className="follow-up-card-actions">
                      <button
                        ref={(element) => {
                          actionRefs.current[item.inputId] = element;
                        }}
                        type="button"
                        aria-label={`Edit ${positionLabel}`}
                        disabled={pendingItem}
                        onClick={() => beginEdit(item)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${positionLabel}`}
                        disabled={pendingItem}
                        onClick={() => void remove(item, index)}
                      >
                        Remove
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
