import { describe, expect, it } from 'vitest';
import { formatSkillList, parseSlashCommand, skillPrompt } from './commands.js';

describe('parseSlashCommand', () => {
  it('parses /skills', () => {
    expect(parseSlashCommand('/skills')).toEqual({ kind: 'skills' });
    expect(parseSlashCommand('  /skills  ')).toEqual({ kind: 'skills' });
  });

  it('parses /help', () => {
    expect(parseSlashCommand('/help')).toEqual({ kind: 'help' });
  });

  it('parses /skill:<name> with input', () => {
    expect(parseSlashCommand('/skill:summarize hi there')).toEqual({
      kind: 'skill',
      name: 'summarize',
      input: 'hi there',
    });
  });

  it('parses /skill <name> with input', () => {
    expect(parseSlashCommand('/skill summarize hello')).toEqual({
      kind: 'skill',
      name: 'summarize',
      input: 'hello',
    });
  });

  it('parses /skill:<name> with no input', () => {
    expect(parseSlashCommand('/skill:summarize')).toEqual({
      kind: 'skill',
      name: 'summarize',
      input: '',
    });
  });

  it('parses /skill:deploy as name "deploy" (not plugin "skill")', () => {
    expect(parseSlashCommand('/skill:deploy now')).toEqual({
      kind: 'skill',
      name: 'deploy',
      input: 'now',
    });
  });

  it('parses Claude-style /<plugin>:<command> [input]', () => {
    expect(parseSlashCommand('/myplugin:deploy staging')).toEqual({
      kind: 'skill',
      name: 'myplugin:deploy',
      input: 'staging',
    });
  });

  it('parses /<plugin>:<command> with no input', () => {
    expect(parseSlashCommand('/myplugin:deploy')).toEqual({
      kind: 'skill',
      name: 'myplugin:deploy',
      input: '',
    });
  });

  it('returns null for non-commands and unknown commands', () => {
    expect(parseSlashCommand('hello there')).toBeNull();
    expect(parseSlashCommand('/unknown thing')).toBeNull();
    expect(parseSlashCommand('/skill')).toBeNull(); // no name → pass through
  });
});

describe('formatSkillList', () => {
  it('lists skills', () => {
    const out = formatSkillList([
      { name: 'a', description: 'does a' },
      { name: 'b', description: 'does b' },
    ]);
    expect(out).toContain('Available skills (2)');
    expect(out).toContain('• a — does a');
  });

  it('handles an empty list', () => {
    expect(formatSkillList([])).toBe('No skills are available.');
  });
});

describe('skillPrompt', () => {
  it('includes input when present', () => {
    expect(skillPrompt('summarize', 'the thread')).toBe(
      "Load and apply the skill 'summarize'. Input: the thread",
    );
  });

  it('omits input when empty', () => {
    expect(skillPrompt('summarize', '')).toBe("Load and apply the skill 'summarize'.");
  });
});
