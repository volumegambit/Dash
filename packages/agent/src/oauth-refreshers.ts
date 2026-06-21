import { refreshAnthropicToken, refreshOpenAICodexToken } from '@earendil-works/pi-ai/oauth';

/** A refreshed OAuth token set (absolute `expires`, epoch ms). */
export interface RefreshedOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

/** Exchanges a refresh token for a new token set. Throws on failure. */
export type OAuthTokenRefresher = (refreshToken: string) => Promise<RefreshedOAuthTokens>;

/**
 * Provider id → refresh function, built from pi-ai's OAuth implementations.
 *
 * The gateway uses these to keep stored OAuth access tokens fresh. pi-ai's
 * `refreshAnthropicToken` / `refreshOpenAICodexToken` already return
 * `{ access, refresh, expires }` (expires is absolute epoch ms with pi-ai's own
 * safety margin baked in), so they satisfy `OAuthTokenRefresher` directly.
 *
 * Keys MUST match the provider ids used in credential-store slots
 * (`{provider}-api-key:{name}`): `anthropic`, `openai`.
 */
export function createOAuthRefreshers(): Record<string, OAuthTokenRefresher> {
  return {
    anthropic: (refreshToken) => refreshAnthropicToken(refreshToken),
    openai: (refreshToken) => refreshOpenAICodexToken(refreshToken),
  };
}
