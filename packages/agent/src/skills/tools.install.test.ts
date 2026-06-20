import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSecurityScanner } from './security.js';
import { createInstallSkillTool, createRemoveSkillTool } from './tools.js';
import type { SkillDiscoveryResult } from './types.js';

const safeScanner: SkillSecurityScanner = async () => ({ verdict: 'safe', reasons: [] });

function resultText(r: { content: { type: string; text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('install_skill / remove_skill tools', () => {
  let root: string;
  let managed: string;
  let fixture: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dash-install-'));
    managed = join(root, 'managed');
    await mkdir(managed, { recursive: true });
    fixture = join(root, 'fixture', 'arxiv-helper');
    await mkdir(fixture, { recursive: true });
    await writeFile(
      join(fixture, 'SKILL.md'),
      '---\nname: arxiv-helper\ndescription: helps\n---\n\nbody\n',
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs a safe skill and marks .source=remote', async () => {
    const onChange = vi.fn();
    const r = await createInstallSkillTool(managed, safeScanner, onChange).execute('id', {
      source: fixture,
    });
    expect(resultText(r)).toMatch(/Installed skill "arxiv-helper"/);
    expect(existsSync(join(managed, 'arxiv-helper', 'SKILL.md'))).toBe(true);
    expect((await readFile(join(managed, 'arxiv-helper', '.source'), 'utf-8')).trim()).toBe(
      'remote',
    );
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('refuses a dangerous skill and writes nothing', async () => {
    const scanner: SkillSecurityScanner = async () => ({ verdict: 'dangerous', reasons: ['bad'] });
    const r = await createInstallSkillTool(managed, scanner).execute('id', { source: fixture });
    expect(resultText(r)).toMatch(/Refused to install/);
    expect(existsSync(join(managed, 'arxiv-helper'))).toBe(false);
  });

  it('fails closed when the scanner throws', async () => {
    const scanner: SkillSecurityScanner = async () => {
      throw new Error('scan down');
    };
    const r = await createInstallSkillTool(managed, scanner).execute('id', { source: fixture });
    expect(resultText(r)).toMatch(/security scan failed/);
    expect(existsSync(join(managed, 'arxiv-helper'))).toBe(false);
  });

  it('installs a suspicious skill with a warning', async () => {
    const scanner: SkillSecurityScanner = async () => ({ verdict: 'suspicious', reasons: ['hmm'] });
    const r = await createInstallSkillTool(managed, scanner).execute('id', { source: fixture });
    expect(resultText(r)).toMatch(/Installed skill/);
    expect(resultText(r)).toMatch(/suspicious/);
    expect(existsSync(join(managed, 'arxiv-helper', 'SKILL.md'))).toBe(true);
  });

  it('refuses to install a duplicate', async () => {
    const tool = createInstallSkillTool(managed, safeScanner);
    await tool.execute('id', { source: fixture });
    const r = await tool.execute('id', { source: fixture });
    expect(resultText(r)).toMatch(/already installed/);
  });

  it('removes a managed skill', async () => {
    await createInstallSkillTool(managed, safeScanner).execute('id', { source: fixture });
    const list = async (): Promise<SkillDiscoveryResult[]> => [
      {
        name: 'arxiv-helper',
        description: 'd',
        location: join(managed, 'arxiv-helper', 'SKILL.md'),
        content: '',
        editable: true,
        source: 'remote',
      },
    ];
    const onChange = vi.fn();
    const r = await createRemoveSkillTool(managed, list, onChange).execute('id', {
      name: 'arxiv-helper',
    });
    expect(resultText(r)).toMatch(/Removed skill/);
    expect(existsSync(join(managed, 'arxiv-helper'))).toBe(false);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('refuses to remove a bundled skill', async () => {
    const list = async (): Promise<SkillDiscoveryResult[]> => [
      {
        name: 'deep-research',
        description: 'd',
        location: '/bundled/deep-research/SKILL.md',
        content: '',
        editable: false,
        source: 'bundled',
      },
    ];
    const r = await createRemoveSkillTool(managed, list).execute('id', { name: 'deep-research' });
    expect(resultText(r)).toMatch(/bundled skill and cannot be removed/);
  });

  it('reports when a skill to remove is not found', async () => {
    const r = await createRemoveSkillTool(managed, async () => []).execute('id', { name: 'nope' });
    expect(resultText(r)).toMatch(/not found/);
  });
});
