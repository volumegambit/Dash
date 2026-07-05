---
name: manage-skills
description: Find, install, remove, and author Dash skills — use when the user asks what skills are available, to add/install or remove a skill, to pull a skill from a public repo, or to create and save a new skill.
tags: [meta, skills]
---

# Manage Skills

## When to use
- The user asks "what skills do I have / are available?", "list my skills", or types `/skills`.
- The user wants to add, install, or pull in a skill — by name, from a public repo, or from a URL or local path.
- The user wants to remove or uninstall a skill.
- The user wants to create, write, or save a new skill (their own reusable workflow).

## Workflow

### Listing what's available
1. To see installed skills, the user can type `/skills` in chat — it lists every skill currently available. You (the agent) already see the installed skills in your system prompt, so you can answer "what can you do?" directly without a tool call.
2. If the user is hunting for a capability that isn't installed, point them to the public ecosystem (see "Finding skills to install") and offer to install one.

### Installing a skill
1. Use the `install_skill` tool. Its input is `{ source, name? }`:
   - `source` (required) is one of:
     - A git ref: `git:owner/repo/subpath@ref` — e.g. `git:NousResearch/hermes-agent/skills/research/arxiv@main`. The `subpath` points at the directory that contains the `SKILL.md`; `@ref` is a branch, tag, or commit (use `@main` if unsure).
     - A direct URL ending in `SKILL.md` — e.g. `https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md`.
     - A local filesystem path to a skill directory or `SKILL.md`.
   - `name` (optional) overrides the installed skill's directory name; omit it to keep the skill's own name.
2. Tell the user what installation does before (or as) you run it, so there are no surprises:
   - Installs are **text-only**: any executable scripts or code files bundled with the skill are **stripped**. Only the `SKILL.md` instructions are kept. The skill orchestrates Dash's existing tools (read, write, edit, bash, grep, find, web_search, web_fetch, todowrite, mcp_*, projects_*, etc.) — it cannot ship its own binaries.
   - Every install passes through an **automatic security scan** that **refuses** skills it judges dangerous (e.g. prompt-injection, data-exfiltration, or destructive instructions). If a skill is refused, relay that to the user — do not try to work around the scan.
3. After installing, confirm the skill name and one-line description back to the user, and mention they can run `/skills` to see it in the list.

### Finding skills to install
1. There's a public SKILL.md ecosystem on GitHub. Well-known sources:
   - `anthropics/skills`
   - `openai/skills`
   - `NousResearch/hermes-agent`
   - `openclaw/agent-skills`
2. Tell the user they can just name a repo and path (or paste a `SKILL.md` URL) and you'll install it. If they describe a capability but don't know where it lives, use `web_search` to locate a matching `SKILL.md` in one of these repos, confirm the `git:` source with the user, then install it.

### Removing a skill
1. Use the `remove_skill` tool with `{ name }`, where `name` is the skill's directory name as shown by `/skills`.
2. **Bundled skills cannot be removed** — they ship with Dash. If the user tries to remove one, explain that and offer an alternative (e.g. they can simply not invoke it). Only skills the user installed can be removed.
3. Confirm removal back to the user.

### Authoring a new skill
1. Clarify three things with the user: what the skill should do, the trigger (WHEN it should fire), and the steps it should follow. A skill is most useful when it captures a repeatable workflow, not a one-off task.
2. Use the `create_skill` tool. It takes:
   - `name`: a short kebab-case name (this becomes the directory name).
   - `description`: ONE sentence stating BOTH what it does AND when to use it — this powers automatic discovery, so make it specific and trigger-oriented.
   - `content`: self-contained markdown instructions.
3. Write the `content` as a complete, standalone playbook — assume the agent reading it later has **no memory of this conversation**. Follow the bundled skill shape: a title, then `## When to use`, `## Workflow` (numbered, self-contained steps that reference Dash's existing tools by name), `## Output`, and `## Guardrails`.
4. Keep it **text-only**: instructions that orchestrate existing tools. Never reference or rely on a bundled script, binary, or external code file — those would be stripped anyway.
5. After creating it, confirm the name and description, and tell the user it now shows up under `/skills` and will trigger automatically when its description matches a request.

## Output
Keep responses to skill management short and concrete:
- For listing: name the relevant skills with their one-line descriptions; don't dump the full library unless asked.
- For install/remove/create: confirm the action, the skill name, and one line on what it does or what to do next (e.g. "run `/skills` to see it").
- If a tool refuses or errors (security scan, bundled-skill removal, bad source), relay the reason plainly and suggest the next step.

## Guardrails
- Never claim a skill is installed, removed, or created without actually calling the corresponding tool and seeing it succeed.
- Respect the security scan. If `install_skill` refuses a skill, do not attempt to bypass it or re-install the same source — report the refusal to the user.
- Set expectations that installs are text-only: if the user expects a skill's bundled scripts to run, explain they're stripped and the skill works by orchestrating Dash's existing tools.
- Confirm before removing a skill, and never imply a bundled skill can be removed.
- When authoring, make the `description` trigger-oriented (it drives discovery) and the `content` fully self-contained — vague descriptions and conversation-dependent steps make a skill that never fires or fails when reused.
- Verify a `git:` source or URL with the user before installing something they didn't explicitly name, especially for repos outside the well-known list.
