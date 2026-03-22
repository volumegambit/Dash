import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthCallbackServer } from './oauth-callback.js';
import { startOAuthCallbackServer } from './oauth-callback.js';
import type { McpLogger, TokenStore } from './types.js';

const KEY_TOKENS = 'tokens';
const KEY_CLIENT_INFO = 'clientInfo';
const KEY_CODE_VERIFIER = 'codeVerifier';
const KEY_DISCOVERY = 'discovery';

export interface DashOAuthClientProviderOptions {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  grantType?: 'authorization_code' | 'client_credentials';
  /** Called when the user needs to visit an authorization URL */
  onAuthUrl?: (url: URL) => void;
  logger?: McpLogger;
}

/**
 * OAuth client provider for MCP HTTP transports.
 * Supports client_credentials and authorization_code grants.
 */
export class DashOAuthClientProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly tokenStore: TokenStore;
  private readonly options: DashOAuthClientProviderOptions;
  private callbackServer: OAuthCallbackServer | null = null;

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

  get redirectUrl(): string | URL | undefined {
    // For client_credentials, no redirect needed
    if (this.options.grantType === 'client_credentials') {
      return undefined;
    }
    // For auth code flow, return the callback server URL if started
    return this.callbackServer?.url;
  }

  get clientMetadata(): OAuthClientMetadata {
    const { clientId, scopes, grantType } = this.options;
    const isAuthCode = grantType === 'authorization_code' || !grantType;

    return {
      redirect_uris: isAuthCode && this.callbackServer ? [this.callbackServer.url.toString()] : [],
      client_name: clientId ?? `dash-mcp-${this.serverName}`,
      grant_types: grantType ? [grantType] : ['authorization_code', 'client_credentials'],
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

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Start the ephemeral callback server if not already running
    if (!this.callbackServer) {
      this.callbackServer = await startOAuthCallbackServer({
        logger: this.options.logger,
      });
    }

    // Notify consumer of the URL the user needs to visit
    this.options.onAuthUrl?.(authorizationUrl);
    this.options.logger?.info(
      `[oauth:${this.serverName}] Authorization required. Visit: ${authorizationUrl}`,
    );
  }

  /**
   * Wait for the OAuth callback to complete and return the authorization code.
   * Called by McpClient after UnauthorizedError is caught.
   */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this.callbackServer) {
      throw new Error(`No OAuth callback server running for "${this.serverName}"`);
    }
    const result = await this.callbackServer.waitForCallback();
    this.callbackServer = null; // Server auto-closes
    return result.code;
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

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    // Only customize for client_credentials
    if (this.options.grantType === 'client_credentials') {
      const params = new URLSearchParams({ grant_type: 'client_credentials' });
      const effectiveScope = scope ?? this.options.scopes?.join(' ');
      if (effectiveScope) {
        params.set('scope', effectiveScope);
      }
      return params;
    }
    // For auth code flow, let the SDK handle the default behavior
    return undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.tokenStore.set(this.storeKey(KEY_DISCOVERY), JSON.stringify(state));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const raw = await this.tokenStore.get(this.storeKey(KEY_DISCOVERY));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as OAuthDiscoveryState;
    } catch {
      return undefined;
    }
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
    if (scope === 'all' || scope === 'discovery') {
      await this.tokenStore.delete(this.storeKey(KEY_DISCOVERY));
    }
  }

  /** Clean up any running callback server */
  dispose(): void {
    this.callbackServer?.close();
    this.callbackServer = null;
  }
}
