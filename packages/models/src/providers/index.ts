import { Anthropic } from './anthropic.js';
import { Google } from './google.js';
import { OpenAI } from './openai.js';
import type { ProviderDefinition } from './types.js';

/**
 * Registry of every supported AI provider. Adding a new provider:
 *
 *  1. Create `packages/models/src/providers/<id>.ts` exporting a
 *     `ProviderDefinition`
 *  2. Append the import to this file's top
 *  3. Append it to the `PROVIDERS` array
 *
 * That's it — the gateway, audit script, CI freshness check, and
 * Under the Hood debug page all iterate this array, so adding one
 * provider becomes invisibly plumbed everywhere downstream.
 */
export const PROVIDERS: readonly ProviderDefinition[] = [Anthropic, OpenAI, Google] as const;

export { Anthropic, OpenAI, Google };
export type { ProviderDefinition } from './types.js';
