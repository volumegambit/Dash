import { join } from 'node:path';
import { type ChannelAdapter, TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import type { ChannelRegistry, RegisteredChannel } from '../channel-registry.js';
import type { GatewayCredentialStore } from '../credential-store.js';

export type ChannelAdapterPurpose = 'create' | 'restore' | 'restart';
export type ChannelAdapterFactory = (
  channel: RegisteredChannel,
  purpose: ChannelAdapterPurpose,
) => Promise<ChannelAdapter>;

/** Expected setup failures, translated to a domain error by the channel service. */
export class ChannelAdapterConfigurationError extends Error {}

export interface ChannelAdapterFactoryOptions {
  channelRegistry: Pick<ChannelRegistry, 'get'>;
  credentialStore: Pick<GatewayCredentialStore, 'get'>;
  dataDir: string;
  /** Construction seams keep adapter networking out of application-service tests. */
  adapters?: {
    telegram(token: string, allowedUsers: () => string[]): ChannelAdapter;
    whatsapp(auth: Record<string, string>, sessionPath: string): ChannelAdapter;
  };
}

export function createChannelAdapterFactory(
  options: ChannelAdapterFactoryOptions,
): ChannelAdapterFactory {
  const adapters = options.adapters ?? {
    telegram: (token: string, allowedUsers: () => string[]) =>
      new TelegramAdapter(token, allowedUsers),
    whatsapp: (auth: Record<string, string>, sessionPath: string) =>
      new WhatsAppAdapter(auth, sessionPath),
  };

  return async (channel, purpose) => {
    const channelName = channel.name;
    if (channel.adapter === 'telegram') {
      const key = `channel:${channelName}:token`;
      const token = await options.credentialStore.get(key);
      if (!token) {
        throw new ChannelAdapterConfigurationError(`No credential found for key '${key}'`);
      }
      return adapters.telegram(
        token,
        () => options.channelRegistry.get(channelName)?.allowedUsers ?? [],
      );
    }

    if (channel.adapter === 'whatsapp') {
      const key = `channel:${channelName}:whatsapp-auth`;
      const authJson = await options.credentialStore.get(key);
      if (!authJson && purpose === 'create') {
        throw new ChannelAdapterConfigurationError(`No credential found for key '${key}'`);
      }
      let auth: Record<string, string> = {};
      if (authJson) {
        try {
          auth = JSON.parse(authJson) as Record<string, string>;
        } catch {
          // JSON.parse errors can contain credential text. Keep the existing
          // unexpected-error classification, without retaining its raw cause.
          throw new Error('Invalid WhatsApp credentials');
        }
      }
      // Deliberately preserve the historical create/restore paths. Unifying
      // these would move existing session data and needs a separate migration.
      const sessionPath =
        purpose === 'create'
          ? `data/whatsapp/${channelName}`
          : join(options.dataDir, 'whatsapp-sessions', channelName);
      return adapters.whatsapp(auth, sessionPath);
    }

    throw new ChannelAdapterConfigurationError(`Unknown adapter type: ${channel.adapter}`);
  };
}
