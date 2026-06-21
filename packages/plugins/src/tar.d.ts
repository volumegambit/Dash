/**
 * Minimal ambient types for the parts of the `tar` (v6) package this package
 * uses. The published `@types/tar` describes an older API surface than `tar@6`'s
 * modern functional API (`tar.x` / `tar.Header`), so a small, accurate local
 * declaration is preferable to a mismatched dependency.
 */
declare module 'tar' {
  import type { Writable } from 'node:stream';

  /** A parsed tar entry handed to `onentry`/`filter`. */
  export interface ReadEntry {
    path: string;
  }

  /** Options accepted by {@link extract} when streaming archive bytes in. */
  export interface ExtractOptions {
    /** Directory to extract into; must exist and be a directory. */
    cwd?: string;
    /** How many leading path components to strip. Unused here (left at 0). */
    strip?: number;
    /** Return `true` to extract an entry, `false` to skip it. */
    filter?: (path: string, entry: ReadEntry) => boolean;
    /** Called for every entry that passes the filter. */
    onentry?: (entry: ReadEntry) => void;
    /** Allow `..`/absolute member paths. Left false (default) for safety. */
    preservePaths?: boolean;
  }

  /**
   * Extract a (optionally gzipped) tar archive. With no `file` option, returns a
   * writable stream — write the archive bytes to it and listen for `finish`.
   */
  export function extract(opts: ExtractOptions): Writable;

  /** Properties accepted when constructing a {@link Header}. */
  export interface HeaderProperties {
    path?: string;
    mode?: number;
    size?: number;
    type?: string;
    mtime?: Date;
  }

  /** A single 512-byte tar header block (used to craft archives in tests). */
  export class Header {
    constructor(props: HeaderProperties);
    encode(): void;
    /** The encoded 512-byte header block (available after {@link encode}). */
    block?: Buffer;
  }
}
