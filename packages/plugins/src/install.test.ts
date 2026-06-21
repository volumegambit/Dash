import { describe, expect, it } from 'vitest';
import { PluginOpError, parsePluginSource } from './install.js';

describe('parsePluginSource', () => {
  it('parses a git source with subpath and ref', () => {
    expect(parsePluginSource('git:owner/repo/plugins/my-plugin@main')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'plugins/my-plugin',
      ref: 'main',
    });
  });

  it('parses a git source without subpath or ref', () => {
    expect(parsePluginSource('git:owner/repo')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: undefined,
      ref: undefined,
    });
  });

  it('parses a git source with subpath but no ref', () => {
    expect(parsePluginSource('git:owner/repo/sub/path')).toEqual({
      kind: 'git',
      owner: 'owner',
      repo: 'repo',
      subpath: 'sub/path',
      ref: undefined,
    });
  });

  it('parses an https url source', () => {
    expect(parsePluginSource('https://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'https://example.com/plugins/x.tar.gz',
    });
  });

  it('parses an http url source', () => {
    expect(parsePluginSource('http://example.com/plugins/x.tar.gz')).toEqual({
      kind: 'url',
      url: 'http://example.com/plugins/x.tar.gz',
    });
  });

  it('treats a relative path as a local source', () => {
    expect(parsePluginSource('./my-plugin')).toEqual({ kind: 'local', path: './my-plugin' });
  });

  it('treats an absolute path as a local source', () => {
    expect(parsePluginSource('/abs/path')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('treats a home-relative path as a local source', () => {
    expect(parsePluginSource('~/plugins/my-plugin')).toEqual({
      kind: 'local',
      path: '~/plugins/my-plugin',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePluginSource('  /abs/path  ')).toEqual({ kind: 'local', path: '/abs/path' });
  });

  it('rejects a malformed git source', () => {
    expect(() => parsePluginSource('git:owner')).toThrow(/Invalid git source/);
  });

  it('rejects an empty source', () => {
    expect(() => parsePluginSource('')).toThrow();
    expect(() => parsePluginSource('   ')).toThrow();
  });
});

describe('PluginOpError', () => {
  it('carries a code and message', () => {
    const err = new PluginOpError('not_found', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PluginOpError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('PluginOpError');
  });

  it('exposes code via the generic `code in err` check', () => {
    const err: unknown = new PluginOpError('duplicate', 'dupe');
    expect(err instanceof Error && 'code' in err).toBe(true);
    expect((err as { code?: string }).code).toBe('duplicate');
  });
});
