import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildMemoryPreamble(workspace: string): Promise<string> {
  const memoryPath = join(workspace, 'MEMORY.md');
  let contents: string | null = null;

  try {
    contents = await readFile(memoryPath, 'utf-8');
  } catch {
    // File does not exist yet
  }

  if (contents && contents.trim()) {
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

  return `You have a persistent memory file at ${memoryPath} (not yet created).
Create it with write_file when you learn something worth remembering.`;
}
