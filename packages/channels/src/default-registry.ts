import { telegramChannelAdapter } from './adapters/telegram.js';
import { whatsappChannelAdapter } from './adapters/whatsapp.js';
import { ChannelAdapterRegistry } from './registry.js';

/**
 * Build a {@link ChannelAdapterRegistry} pre-populated with every
 * channel adapter that ships in `@dash/channels` (Telegram, WhatsApp).
 *
 * The gateway constructs this once at startup and threads it through
 * the channel restore loop, the management API, and the credential
 * rotation hook. Tests that need a clean registry can instead
 * `new ChannelAdapterRegistry()` and register only what they care
 * about.
 */
export function createDefaultChannelAdapterRegistry(): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  registry.register(telegramChannelAdapter);
  registry.register(whatsappChannelAdapter);
  return registry;
}
