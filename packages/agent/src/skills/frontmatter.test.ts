import { describe, expect, it } from 'vitest';
import { generateFrontmatter, parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses required fields (name, description) and content', () => {
    const raw = `---
name: my-skill
description: Does something useful
---

# My Skill

This is the skill content.`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result?.frontmatter.name).toBe('my-skill');
    expect(result?.frontmatter.description).toBe('Does something useful');
    expect(result?.content).toBe('# My Skill\n\nThis is the skill content.');
  });

  it('parses all optional fields', () => {
    const raw = `---
name: full-skill
description: A fully featured skill
trigger: /full
model: claude-opus-4-5
context: fork
tools:
  - bash
  - read
tags:
  - utility
  - advanced
allowed-tools:
  - bash
dependencies:
  - other-skill
---

Skill body here.`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    const fm = result?.frontmatter;
    expect(fm.name).toBe('full-skill');
    expect(fm.description).toBe('A fully featured skill');
    expect(fm.trigger).toBe('/full');
    expect(fm.model).toBe('claude-opus-4-5');
    expect(fm.context).toBe('fork');
    expect(fm.tools).toEqual(['bash', 'read']);
    expect(fm.tags).toEqual(['utility', 'advanced']);
    expect(fm['allowed-tools']).toEqual(['bash']);
    expect(fm.dependencies).toEqual(['other-skill']);
    expect(result?.content).toBe('Skill body here.');
  });

  it('parses inline arrays', () => {
    const raw = `---
name: inline-skill
description: Uses inline arrays
tools: [bash, read, write]
tags: [utility]
---

Content here.`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result?.frontmatter.tools).toEqual(['bash', 'read', 'write']);
    expect(result?.frontmatter.tags).toEqual(['utility']);
  });

  it('returns null for missing frontmatter', () => {
    const raw = `# Just a plain markdown file

No frontmatter here.`;

    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('returns null when frontmatter has no closing marker', () => {
    const raw = `---
name: broken
description: No closing marker`;

    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('returns null for empty name', () => {
    const raw = `---
name:
description: Has no name
---

Content.`;

    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('returns null for missing name field', () => {
    const raw = `---
description: No name field at all
---

Content.`;

    expect(parseFrontmatter(raw)).toBeNull();
  });

  it('trims content whitespace', () => {
    const raw = `---
name: trim-skill
description: Content gets trimmed
---


   Leading and trailing whitespace


`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Leading and trailing whitespace');
  });

  it('handles empty content after frontmatter', () => {
    const raw = `---
name: no-content
description: Skill with no body
---
`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result?.content).toBe('');
  });

  it('handles empty optional arrays gracefully', () => {
    const raw = `---
name: empty-arrays
description: Arrays with no items
tools: []
tags: []
---

Content.`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    // Empty inline arrays parse as empty arrays but the frontmatter interface
    // only sets them if present — since [] is empty, we check they're not set
    // (the implementation filters out empty inline arrays via the parseValue path;
    //  however SkillFrontmatter allows optional arrays, so presence is optional)
    expect(result?.frontmatter.tools).toEqual([]);
    expect(result?.frontmatter.tags).toEqual([]);
  });

  it('handles description with colons in it', () => {
    const raw = `---
name: colon-skill
description: Does something: with a colon
---

Content.`;

    const result = parseFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result?.frontmatter.description).toBe('Does something: with a colon');
  });
});

describe('generateFrontmatter', () => {
  it('generates frontmatter with required fields only', () => {
    const result = generateFrontmatter(
      { name: 'my-skill', description: 'Does something useful' },
      'Skill instructions here.',
    );

    expect(result).toBe(
      '---\nname: my-skill\ndescription: Does something useful\n---\n\nSkill instructions here.',
    );
  });

  it('generates frontmatter with all optional fields', () => {
    const result = generateFrontmatter(
      {
        name: 'full-skill',
        description: 'Full featured',
        trigger: '/full',
        model: 'claude-opus-4-5',
        context: 'fork',
        tools: ['bash', 'read'],
        tags: ['utility', 'advanced'],
        'allowed-tools': ['bash'],
        dependencies: ['other-skill'],
      },
      'Body.',
    );

    expect(result).toContain('name: full-skill');
    expect(result).toContain('description: Full featured');
    expect(result).toContain('trigger: /full');
    expect(result).toContain('model: claude-opus-4-5');
    expect(result).toContain('context: fork');
    expect(result).toContain('tools:\n  - bash\n  - read');
    expect(result).toContain('tags:\n  - utility\n  - advanced');
    expect(result).toContain('allowed-tools:\n  - bash');
    expect(result).toContain('dependencies:\n  - other-skill');
    expect(result).toContain('---\n\nBody.');
  });

  it('does not include optional fields when they are undefined', () => {
    const result = generateFrontmatter(
      { name: 'minimal', description: 'Minimal skill' },
      'Content.',
    );

    expect(result).not.toContain('trigger');
    expect(result).not.toContain('model');
    expect(result).not.toContain('context');
    expect(result).not.toContain('tools');
    expect(result).not.toContain('tags');
    expect(result).not.toContain('allowed-tools');
    expect(result).not.toContain('dependencies');
  });

  it('does not include empty arrays', () => {
    const result = generateFrontmatter(
      { name: 'empty-arrays', description: 'Has empty arrays', tools: [], tags: [] },
      'Content.',
    );

    expect(result).not.toContain('tools:');
    expect(result).not.toContain('tags:');
  });
});

describe('round-trip (generate then parse)', () => {
  it('produces the same result after generate then parse — required fields only', () => {
    const fm = { name: 'round-trip', description: 'Survives a round trip' };
    const content = 'Round trip content.';

    const generated = generateFrontmatter(fm, content);
    const parsed = parseFrontmatter(generated);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.name).toBe(fm.name);
    expect(parsed?.frontmatter.description).toBe(fm.description);
    expect(parsed?.content).toBe(content);
  });

  it('produces the same result after generate then parse — all optional fields', () => {
    const fm = {
      name: 'full-round-trip',
      description: 'Full skill round trip',
      trigger: '/full',
      model: 'claude-opus-4-5',
      context: 'fork' as const,
      tools: ['bash', 'read', 'write'],
      tags: ['utility'],
      'allowed-tools': ['bash'],
      dependencies: ['dep-skill'],
    };
    const content = 'Full skill body.';

    const generated = generateFrontmatter(fm, content);
    const parsed = parseFrontmatter(generated);

    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter).toEqual(fm);
    expect(parsed?.content).toBe(content);
  });
});
