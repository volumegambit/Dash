import type { MobileImage, MobileImageMediaType } from '@dash/mobile-contract';

/**
 * Composer image attachments (chat-ux Phase 4 Task 5, audit #14 remainder).
 * Pure rules + a file reader, kept out of `ChatView` so the limits are unit
 * tested without a DOM. The limits mirror iOS's `ImageAttachmentValidator`
 * exactly — the gateway contract (`MobileImage`) is shared, so both clients
 * must refuse the same files with the same copy.
 */
export const IMAGE_ATTACHMENT_LIMITS = {
  maxCount: 4,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
} as const;

export const IMAGE_MEDIA_TYPES: readonly MobileImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

export const ATTACHMENT_COPY = {
  unsupportedType: 'Unsupported image type. Use PNG, JPG, GIF, or WebP.',
  fileTooLarge: 'Image must be under 5 MB.',
  tooMany: 'Maximum 4 images per message.',
  totalTooLarge: 'Images must total under 12 MB.',
} as const;

/** One attached-but-unsent image: the contract fields plus what the strip needs. */
export interface PendingImageAttachment extends MobileImage {
  id: string;
  /** `data:` URL for the `<img>` preview. */
  preview: string;
  bytes: number;
}

export function isImageMediaType(type: string): type is MobileImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/**
 * Applies the limits in order (type → per-file size → count → total),
 * keeping every file that passes and reporting the FIRST rejection reason —
 * one line of copy under the composer, not a list.
 */
export function validateImageFiles(
  existing: ReadonlyArray<{ bytes: number }>,
  files: ReadonlyArray<File>,
): { accepted: File[]; error: string | null } {
  const accepted: File[] = [];
  let error: string | null = null;
  let count = existing.length;
  let total = existing.reduce((sum, item) => sum + item.bytes, 0);
  const reject = (reason: string) => {
    if (error === null) error = reason;
  };
  for (const file of files) {
    if (!isImageMediaType(file.type)) {
      reject(ATTACHMENT_COPY.unsupportedType);
      continue;
    }
    if (file.size > IMAGE_ATTACHMENT_LIMITS.maxFileBytes) {
      reject(ATTACHMENT_COPY.fileTooLarge);
      continue;
    }
    if (count >= IMAGE_ATTACHMENT_LIMITS.maxCount) {
      reject(ATTACHMENT_COPY.tooMany);
      continue;
    }
    if (total + file.size > IMAGE_ATTACHMENT_LIMITS.maxTotalBytes) {
      reject(ATTACHMENT_COPY.totalTooLarge);
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }
  return { accepted, error };
}

function toBase64(bytes: Uint8Array): string {
  // Chunked (review M4): per-byte string concatenation over a 5 MB file is
  // needlessly quadratic-ish; 32 KiB slices keep `fromCharCode`'s argument
  // list under engine limits and the concat count small.
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Reads a validated file into the contract shape plus a preview URL. Uses
 * `arrayBuffer()` rather than `FileReader` so it behaves identically in
 * browsers and in the happy-dom test environment. */
export async function readImageFile(file: File): Promise<PendingImageAttachment> {
  const mediaType = file.type as MobileImageMediaType;
  const data = toBase64(new Uint8Array(await file.arrayBuffer()));
  return {
    id: crypto.randomUUID(),
    mediaType,
    data,
    preview: `data:${mediaType};base64,${data}`,
    bytes: file.size,
  };
}

/** Image `File`s from a `FileList`, a `DataTransferItemList`, or a plain
 * array (paste, drop, and the file input all funnel through here). */
export function imageFilesFrom(
  source: FileList | DataTransferItemList | ReadonlyArray<File> | null | undefined,
): File[] {
  if (!source) return [];
  const files: File[] = [];
  for (const item of Array.from(source as ArrayLike<File | DataTransferItem>)) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && isImageMediaType(file.type)) files.push(file);
  }
  return files;
}

/**
 * Whether a drag carries at least one image file — decided from `kind` and
 * `type` ONLY. During `dragover` the drag data store is in protected mode
 * and `getAsFile()` returns `null` by spec (Phase 4 review I2), so
 * `imageFilesFrom` would always say "no" there; this is the check to use
 * for accepting a drag. `drop` then reads `dataTransfer.files` for real.
 */
export function hasImageItems(items: DataTransferItemList | null | undefined): boolean {
  if (!items) return false;
  return Array.from(items).some((item) => item.kind === 'file' && isImageMediaType(item.type));
}
