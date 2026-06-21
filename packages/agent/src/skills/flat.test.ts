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
    const skills = await loadFlatSkills([{ file: f }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: 'deploy', description: 'deploy the app', location: f });
  });

  it('falls back to the file basename when frontmatter has no name', async () => {
    const f = join(dir, 'rollback.md');
    await writeFile(f, 'Just a body, no frontmatter.');
    const skills = await loadFlatSkills([{ file: f }]);
    expect(skills[0].name).toBe('rollback');
    expect(skills[0].location).toBe(f);
  });

  it('keeps the description when frontmatter has no name (name = basename)', async () => {
    const f = join(dir, 'release.md');
    await writeFile(f, '---\ndescription: ship a release\n---\nDo the release.');
    const skills = await loadFlatSkills([{ file: f }]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('release');
    expect(skills[0].description).toBe('ship a release');
    expect(skills[0].content).toBe('Do the release.');
  });

  it('skips files that cannot be read without throwing', async () => {
    const skills = await loadFlatSkills([{ file: join(dir, 'missing.md') }]);
    expect(skills).toEqual([]);
  });

  it('namespaces the derived basename when a namespace is given', async () => {
    const f = join(dir, 'foo.md');
    await writeFile(f, '# Foo\nDo the foo.');
    const skills = await loadFlatSkills([{ file: f, namespace: 'bar' }]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('bar:foo');
    expect(skills[0].location).toBe(f);
  });

  it('namespaces the frontmatter name when both are given', async () => {
    const f = join(dir, 'foo.md');
    await writeFile(f, '---\nname: deploy\ndescription: deploy the app\n---\nDo it.');
    const skills = await loadFlatSkills([{ file: f, namespace: 'bar' }]);
    expect(skills[0].name).toBe('bar:deploy');
    expect(skills[0].description).toBe('deploy the app');
  });

  it('does not namespace when namespace is omitted', async () => {
    const f = join(dir, 'foo.md');
    await writeFile(f, '# Foo\nDo the foo.');
    const skills = await loadFlatSkills([{ file: f }]);
    expect(skills[0].name).toBe('foo');
  });
});
