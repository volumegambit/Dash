import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MemoryPreambleOptions {
  /**
   * Emit the memory BODY without any instruction to update the file.
   *
   * The default preamble tells the reader to rewrite MEMORY.md with
   * `write_file` — a whole-file overwrite. That is safe for a single
   * conversation, but spawned sub-agents run several at a time on the SAME
   * workspace, each holding a spawn-time snapshot of the file and each told to
   * rewrite it: a lost-update/truncation pattern on a user-visible,
   * cross-conversation artifact that is usually not under version control.
   * Children therefore READ memory and report their findings instead.
   */
  readOnly?: boolean;
}

export async function buildMemoryPreamble(
  workspace: string,
  options: MemoryPreambleOptions = {},
): Promise<string> {
  const memoryPath = join(workspace, 'MEMORY.md');
  let contents: string | null = null;

  try {
    contents = await readFile(memoryPath, 'utf-8');
  } catch {
    // File does not exist yet
  }

  if (contents?.trim()) {
    if (options.readOnly) {
      return `You have a persistent memory file at ${memoryPath}.

Read it to recall important context. It is READ-ONLY for you: do not modify
it. Anything worth remembering belongs in your final report, and the agent
that delegated this task decides what to record.

Current memory:
---
${contents.trim()}
---`;
    }
    return `You have a persistent memory file at ${memoryPath}.

At the start of each conversation, read it to recall important context.
Proactively update it when you learn something worth remembering — user
preferences, project details, recurring tasks, important facts. Use
write_file to save memories. Keep entries concise and dated (YYYY-MM-DD).

Current memory:
---
${contents.trim()}
---`;
  }

  if (options.readOnly) {
    return `There is no persistent memory file at ${memoryPath} yet, so there is no
prior context to recall. Do not create one — put anything worth remembering in
your final report instead.`;
  }

  return `You have a persistent memory file at ${memoryPath} (not yet created).
Create it with write_file when you learn something worth remembering.`;
}
