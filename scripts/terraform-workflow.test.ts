import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

describe('terraform.yml', () => {
  it('validates deploy/aws on pull requests and main without any cloud credentials', async () => {
    const wf = parse(await readFile('.github/workflows/terraform.yml', 'utf8'));
    expect(wf.on.pull_request.paths).toEqual(expect.arrayContaining(['deploy/aws/**']));
    expect(wf.on.push.branches).toEqual(['main']);
    const steps: { run?: string; with?: Record<string, unknown> }[] = wf.jobs.validate.steps;
    const commands = steps.map((s) => s.run ?? '').join('\n');
    expect(commands).toContain('terraform fmt -check');
    expect(commands).toContain('terraform init -backend=false');
    expect(commands).toContain('terraform validate');
    expect(commands).toContain('cloud-init schema');
    expect(commands).not.toContain('terraform apply');
    expect(JSON.stringify(wf)).not.toMatch(/AWS_ACCESS_KEY|aws-actions\/configure-aws-credentials/);
  });
});
