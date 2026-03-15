import { AVAILABLE_TOOLS } from '../components/deploy-options.js';
import type { ToolOption } from '../components/deploy-options.js';

export function useAvailableTools(): ToolOption[] {
  return AVAILABLE_TOOLS;
}
