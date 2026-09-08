import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

type Step = { name?: string; if?: string; uses?: string; run?: string };
type Job = {
  needs?: string | string[];
  environment?: string;
  uses?: string;
  if?: string;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

async function load(file: string): Promise<Workflow> {
  return parse(await readFile(`.github/workflows/${file}`, 'utf8')) as Workflow;
}

const needsOf = (job: Job): string[] =>
  Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];

/** Jobs that touch a live target must declare an environment and a config guard. */
function expectGuardedDeployJob(job: Job, environment: string) {
  expect(job.environment).toBe(environment);
  const guard = job.steps?.find((s) => s.name === 'Check configuration');
  expect(guard?.run).toContain('configured=');
  for (const step of job.steps ?? []) {
    if (step === guard) continue;
    expect(step.if).toContain("steps.cfg.outputs.configured == 'true'");
  }
}

describe('deploy-staging.yml', () => {
  it('runs after CI succeeds on main, or by hand', async () => {
    const wf = await load('deploy-staging.yml');
    const run = wf.on.workflow_run as { workflows: string[]; branches: string[] };
    expect(run.workflows).toEqual(['CI']);
    expect(run.branches).toEqual(['main']);
    expect(wf.on).toHaveProperty('workflow_dispatch');
    expect(wf.jobs.gate.if).toContain("workflow_run.conclusion == 'success'");
  });

  it('builds the image through the reusable workflow and deploys to the staging environment', async () => {
    const wf = await load('deploy-staging.yml');
    expect(wf.jobs.image.uses).toBe('./.github/workflows/server-image.yml');
    for (const name of ['server', 'web', 'waitlist']) {
      expect(needsOf(wf.jobs[name])).toContain('gate');
      expectGuardedDeployJob(wf.jobs[name], 'staging');
    }
    expect(needsOf(wf.jobs.server)).toContain('image');
  });
});

describe('release.yml', () => {
  it('triggers only on version tags', async () => {
    const wf = await load('release.yml');
    expect(wf.on).toEqual({ push: { tags: ['v*'] } });
  });

  it('verifies the version first and gates every artifact on the test suite', async () => {
    const wf = await load('release.yml');
    const verifyRun = wf.jobs.verify.steps?.map((s) => s.run ?? '').join('\n') ?? '';
    expect(verifyRun).toContain('scripts/check-release-version.mjs');
    expect(verifyRun).toContain('gh release create');
    expect(verifyRun).toContain('--draft');
    for (const name of Object.keys(wf.jobs)) {
      if (name === 'verify') continue;
      expect(needsOf(wf.jobs[name]), `${name} must depend on verify`).toContain('verify');
    }
    for (const name of ['image', 'desktop', 'web', 'waitlist', 'ios', 'android']) {
      expect(needsOf(wf.jobs[name]), `${name} must depend on gates`).toContain('gates');
    }
    expect(needsOf(wf.jobs.server)).toContain('image');
  });

  it('protects every live target with the production environment', async () => {
    const wf = await load('release.yml');
    for (const name of ['web', 'waitlist', 'server', 'ios', 'android']) {
      expectGuardedDeployJob(wf.jobs[name], 'production');
    }
    // Desktop only fills a DRAFT release; publishing it is the human gate.
    expect(wf.jobs.desktop.environment).toBeUndefined();
  });
});

describe('server-image.yml', () => {
  it('is reusable and validates on pull requests that touch the image inputs', async () => {
    const wf = await load('server-image.yml');
    const call = wf.on.workflow_call as {
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
    };
    expect(Object.keys(call.inputs).sort()).toEqual(['push', 'ref', 'tags']);
    expect(call.outputs).toHaveProperty('image');
    const pr = wf.on.pull_request as { paths: string[] };
    expect(pr.paths).toEqual(
      expect.arrayContaining(['deploy/server/**', 'apps/relay/**', 'apps/relay-control-plane/**']),
    );
  });
});
