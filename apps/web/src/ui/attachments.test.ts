import { describe, expect, it } from 'vitest';
import {
  IMAGE_ATTACHMENT_LIMITS,
  imageFilesFrom,
  readImageFile,
  validateImageFiles,
} from './attachments.js';

/**
 * Chat UX Phase 4 Task 5 (audit #14 remainder): the composer's attachment
 * rules, kept pure so they're testable without a DOM. The limits mirror
 * iOS's `ImageAttachmentValidator` exactly (4 images, 5 MB each, 12 MB per
 * message, PNG/JPEG/GIF/WebP) — the gateway contract is shared, so the two
 * clients must refuse the same files.
 */
function file(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('image attachment validation (chat-ux Phase 4 Task 5)', () => {
  it('mirrors the iOS limits', () => {
    expect(IMAGE_ATTACHMENT_LIMITS).toEqual({
      maxCount: 4,
      maxFileBytes: 5 * 1024 * 1024,
      maxTotalBytes: 12 * 1024 * 1024,
    });
  });

  it('accepts supported image types and rejects everything else by name', () => {
    const result = validateImageFiles(
      [],
      [file('a.png', 'image/png', 10), file('b.txt', 'text/plain', 10)],
    );
    expect(result.accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(result.error).toBe('Unsupported image type. Use PNG, JPG, GIF, or WebP.');
  });

  it('rejects a single file over 5 MB but keeps the others', () => {
    const big = file('big.jpg', 'image/jpeg', IMAGE_ATTACHMENT_LIMITS.maxFileBytes + 1);
    const result = validateImageFiles([], [file('ok.gif', 'image/gif', 10), big]);
    expect(result.accepted.map((f) => f.name)).toEqual(['ok.gif']);
    expect(result.error).toBe('Image must be under 5 MB.');
  });

  it('caps the message at 4 images counting ones already attached', () => {
    const existing = [{ bytes: 10 }, { bytes: 10 }, { bytes: 10 }];
    const result = validateImageFiles(existing, [
      file('a.webp', 'image/webp', 10),
      file('b.webp', 'image/webp', 10),
    ]);
    expect(result.accepted.map((f) => f.name)).toEqual(['a.webp']);
    expect(result.error).toBe('Maximum 4 images per message.');
  });

  it('caps the total at 12 MB across attached and new files', () => {
    const four = 4 * 1024 * 1024;
    const existing = [{ bytes: four }, { bytes: four }];
    const result = validateImageFiles(existing, [
      file('a.png', 'image/png', four),
      file('b.png', 'image/png', 1),
    ]);
    expect(result.accepted.map((f) => f.name)).toEqual(['a.png']);
    expect(result.error).toBe('Images must total under 12 MB.');
  });

  it('reads a file into the contract shape plus a data-URL preview', async () => {
    const attachment = await readImageFile(
      new File([new Uint8Array([104, 105])], 'hi.png', { type: 'image/png' }),
    );
    expect(attachment.mediaType).toBe('image/png');
    expect(attachment.data).toBe('aGk=');
    expect(attachment.preview).toBe('data:image/png;base64,aGk=');
    expect(attachment.bytes).toBe(2);
    expect(attachment.id).toBeTruthy();
  });

  it('extracts image files from a FileList-like and ignores non-file items', () => {
    const png = file('a.png', 'image/png', 3);
    const txt = file('a.txt', 'text/plain', 3);
    expect(imageFilesFrom([png, txt])).toEqual([png]);
    expect(imageFilesFrom(null)).toEqual([]);
  });
});
