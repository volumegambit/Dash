/**
 * Neutralise a closing delimiter inside untrusted memory text.
 *
 * Memory bodies and descriptions are written by the model, by the post-turn
 * sweep (which derives them from raw user chat text) and by the HTTP PUT route,
 * then interpolated into the system prompt inside `<memory>` /
 * `<recalled-memories>` blocks. Text that closes its own block would leave the
 * rest of the memory floating at the top level of the system prompt on every
 * turn — so every such interpolation must go through THIS function, and adding
 * a third block means adding one more call here, not a second escape.
 *
 * Matching is case-insensitive and whitespace-tolerant, covering the variants a
 * writer can reach for: `</MEMORY>`, `</memory >`, `</ memory>`, `< /memory>`.
 */
export function escapeClosingTag(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'gi'), `&lt;/${tag}&gt;`);
}
