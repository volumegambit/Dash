import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenStore } from './types.js';

const KEY_TOKENS = 'tokens';
const KEY_CLIENT_INFO = 'clientInfo';
const KEY_CODE_VERIFIER = 'codeVerifier';

export interface DashOAuthClientProviderOptions {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}

/**
 * OAuth client provider for MCP HTTP transports.
 * Supports client_credentials grant. Authorization code flow throws — not yet supported.
 */
export class DashOAuthClientProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly tokenStore: TokenStore;
  private readonly options: DashOAuthClientProviderOptions;

  constructor(
    serverName: string,
    tokenStore: TokenStore,
    options: DashOAuthClientProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.tokenStore = tokenStore;
    this.options = options;
  }

  private storeKey(suffix: string): string {
    return `mcp:${this.serverName}:${suffix}`;
  }

  get redirectUrl(): undefined {
    return undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    const { clientId, scopes } = this.options;
    return {
      redirect_uris: [],
      client_name: clientId ?? `dash-mcp-${this.serverName}`,
      grant_types: ['client_credentials'],
      token_endpoint_auth_method: 'client_secret_basic',
      scope: scopes?.join(' '),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const { clientId, clientSecret } = this.options;

    // If static credentials are configured, return them directly.
    if (clientId) {
      return { client_id: clientId, client_secret: clientSecret };
    }

    const raw = await this.tokenStore.get(this.storeKey(KEY_CLIENT_INFO));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.tokenStore.set(this.storeKey(KEY_CLIENT_INFO), JSON.stringify(clientInformation));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await this.tokenStore.get(this.storeKey(KEY_TOKENS));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.tokenStore.set(this.storeKey(KEY_TOKENS), JSON.stringify(tokens));
  }

  redirectToAuthorization(_authorizationUrl: URL): void {
    throw new Error(
      `Authorization code flow is not yet supported for MCP server "${this.serverName}". Configure client_credentials instead.`,
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.tokenStore.set(this.storeKey(KEY_CODE_VERIFIER), codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.tokenStore.get(this.storeKey(KEY_CODE_VERIFIER));
    if (!verifier) {
      throw new Error(`No code verifier stored for MCP server "${this.serverName}".`);
    }
    return verifier;
  }

  prepareTokenRequest(scope?: string): URLSearchParams {
    const params = new URLSearchParams({ grant_type: 'client_credentials' });
    const effectiveScope = scope ?? this.options.scopes?.join(' ');
    if (effectiveScope) {
      params.set('scope', effectiveScope);
    }
    return params;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'all' || scope === 'tokens') {
      await this.tokenStore.delete(this.storeKey(KEY_TOKENS));
    }
    if (scope === 'all' || scope === 'client') {
      await this.tokenStore.delete(this.storeKey(KEY_CLIENT_INFO));
    }
    if (scope === 'all' || scope === 'verifier') {
      await this.tokenStore.delete(this.storeKey(KEY_CODE_VERIFIER));
    }
  }
}
