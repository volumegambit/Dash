import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Command } from 'commander';
import type { SkillsConfig } from '@dash/management';
import { resolveClient } from '../context.js';

interface CommonOpts {
  token?: string;
  agent?: string;
}

async function editInEditor(initial: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-skill-'));
  const filePath = join(dir, 'SKILL.md');
  try {
    await writeFile(filePath, initial, 'utf8');
    const editor = process.env.EDITOR ?? 'vi';
    spawnSync(editor, [filePath], { stdio: 'inherit' });
    const updated = await readFile(filePath, 'utf8');
    return updated;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerSkillsCommand(program: Command): void {
  const skills = program.command('skills').description('Manage agent skills');

  // mc skills list <target>
  skills
    .command('list <target>')
    .description('List skills for an agent')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
    .action(async (target: string, opts: CommonOpts) => {
      try {
        const client = await resolveClient(target, opts.token);
        const info = await client.info();
        const agentName = opts.agent ?? info.agents[0]?.name;
        if (!agentName) {
          console.error('No agent found.');
          process.exitCode = 1;
          return;
        }
        const list = await client.skills(agentName);
        if (list.length === 0) {
          console.log('No skills found.');
          return;
        }
        for (const skill of list) {
          const editTag = skill.editable ? '  [editable]' : '';
          console.log(`  ${skill.name}${editTag}`);
          if (skill.description) {
            console.log(`    ${skill.description}`);
          }
          console.log(`    ${skill.location}`);
        }
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // mc skills show <target> <skillName>
  skills
    .command('show <target> <skillName>')
    .description('Show the content of a skill')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
    .action(async (target: string, skillName: string, opts: CommonOpts) => {
      try {
        const client = await resolveClient(target, opts.token);
        const info = await client.info();
        const agentName = opts.agent ?? info.agents[0]?.name;
        if (!agentName) {
          console.error('No agent found.');
          process.exitCode = 1;
          return;
        }
        const skill = await client.skill(agentName, skillName);
        process.stdout.write(skill.content);
        if (!skill.content.endsWith('\n')) process.stdout.write('\n');
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // mc skills edit <target> <skillName>
  skills
    .command('edit <target> <skillName>')
    .description('Edit a skill in $EDITOR')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
    .action(async (target: string, skillName: string, opts: CommonOpts) => {
      try {
        const client = await resolveClient(target, opts.token);
        const info = await client.info();
        const agentName = opts.agent ?? info.agents[0]?.name;
        if (!agentName) {
          console.error('No agent found.');
          process.exitCode = 1;
          return;
        }
        const skill = await client.skill(agentName, skillName);
        if (!skill.editable) {
          console.error(`Skill "${skillName}" is not editable.`);
          process.exitCode = 1;
          return;
        }
        const updated = await editInEditor(skill.content);
        await client.updateSkillContent(agentName, skillName, updated);
        console.log(`✓ Skill "${skillName}" updated.`);
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // mc skills create <target> <skillName>
  skills
    .command('create <target> <skillName>')
    .description('Create a new skill')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
    .option('-d, --description <desc>', 'Skill description', 'A custom skill')
    .action(
      async (target: string, skillName: string, opts: CommonOpts & { description: string }) => {
        try {
          const client = await resolveClient(target, opts.token);
          const info = await client.info();
          const agentName = opts.agent ?? info.agents[0]?.name;
          if (!agentName) {
            console.error('No agent found.');
            process.exitCode = 1;
            return;
          }
          const placeholder = `# ${skillName}\n\n${opts.description}\n`;
          const content = await editInEditor(placeholder);
          const created = await client.createSkill(agentName, skillName, opts.description, content);
          console.log(`✓ Skill "${skillName}" created at ${created.location}`);
        } catch (err) {
          console.error(`Failed: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  // mc skills config subcommand group
  const config = skills.command('config').description('Manage skills configuration');

  // mc skills config get <target>
  config
    .command('get <target>')
    .description('Get skills configuration')
    .option('-t, --token <token>', 'Management API token (required for URL targets)')
    .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
    .action(async (target: string, opts: CommonOpts) => {
      try {
        const client = await resolveClient(target, opts.token);
        const info = await client.info();
        const agentName = opts.agent ?? info.agents[0]?.name;
        if (!agentName) {
          console.error('No agent found.');
          process.exitCode = 1;
          return;
        }
        const cfg = await client.skillsConfig(agentName);
        console.log(JSON.stringify(cfg, null, 2));
      } catch (err) {
        console.error(`Failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  function makeConfigMutate(
    name: string,
    description: string,
    mutate: (cfg: SkillsConfig, value: string) => SkillsConfig,
  ): void {
    config
      .command(`${name} <target> <value>`)
      .description(description)
      .option('-t, --token <token>', 'Management API token (required for URL targets)')
      .option('-a, --agent <name>', 'Agent name (defaults to first agent)')
      .action(async (target: string, value: string, opts: CommonOpts) => {
        try {
          const client = await resolveClient(target, opts.token);
          const info = await client.info();
          const agentName = opts.agent ?? info.agents[0]?.name;
          if (!agentName) {
            console.error('No agent found.');
            process.exitCode = 1;
            return;
          }
          const current = await client.skillsConfig(agentName);
          const updated = mutate(current, value);
          const result = await client.updateSkillsConfig(agentName, updated);
          console.log('✓ Done.');
          if (result.requiresRestart) {
            console.log(`⚠ Restart required. Run: mc restart ${target}`);
          }
        } catch (err) {
          console.error(`Failed: ${(err as Error).message}`);
          process.exitCode = 1;
        }
      });
  }

  makeConfigMutate('add-path', 'Add a skills directory path', (cfg, value) => ({
    ...cfg,
    paths: [...cfg.paths, value],
  }));

  makeConfigMutate('remove-path', 'Remove a skills directory path', (cfg, value) => ({
    ...cfg,
    paths: cfg.paths.filter((p) => p !== value),
  }));

  makeConfigMutate('add-url', 'Add a skills URL', (cfg, value) => ({
    ...cfg,
    urls: [...cfg.urls, value],
  }));

  makeConfigMutate('remove-url', 'Remove a skills URL', (cfg, value) => ({
    ...cfg,
    urls: cfg.urls.filter((u) => u !== value),
  }));
}
