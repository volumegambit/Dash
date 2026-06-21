import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlatSkills } from './flat.js';

describe('loadFlatSkills', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'flat-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses frontmatter name/description from a flat command file', async () => {
    const f = join(dir, 'deploy.md');
    await writeFile(f, '---\nname: deploy\ndescription: deploy the app\n---\nDo the deploy.');
    const skills = await loadFlatSkills([f]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'deploy', description: 'deploy the app', location: f });
  });

  it('falls back to the file basename when frontmatter has no name', async () => {
    const f = join(dir, 'rollback.md');
    await writeFile(f, 'Just a body, no frontmatter.');
    const skills = await loadFlatSkills([f]);
    expect(skills[0].name).toBe('rollback');
    expect(skills[0].location).toBe(f);
  });

  it('skips files that cannot be read without throwing', async () => {
    const skills = await loadFlatSkills([join(dir, 'missing.md')]);
    expect(skills).toEqual([]);
  });
});
