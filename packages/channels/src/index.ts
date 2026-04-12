export type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  MessageHandler,
  ChannelHealth,
} from './types.js';
export type { RouterRoutingRule, RouterConfig, MessageLogEntry, MessageLogger } from './types.js';
export { MessageRouter } from './router.js';
export { MissionControlAdapter } from './adapters/mission-control.js';
export { TelegramAdapter } from './adapters/telegram.js';
export type { TelegramAllowedUsers } from './adapters/telegram.js';
export { WhatsAppAdapter } from './adapters/whatsapp.js';
export { makeBaileysAuthState } from './adapters/whatsapp-auth.js';
export type { BaileysAuthState } from './adapters/whatsapp-auth.js';
export { startWhatsAppPairing } from './adapters/whatsapp-pairing.js';
export type { PairingCallbacks } from './adapters/whatsapp-pairing.js';
