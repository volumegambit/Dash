export type { ChannelAdapter, InboundMessage, OutboundMessage, MessageHandler, ChannelHealth } from './types.js';
export type { RouterRoutingRule, RouterConfig } from './types.js';
export { MessageRouter } from './router.js';
export { MissionControlAdapter } from './adapters/mission-control.js';
export { TelegramAdapter } from './adapters/telegram.js';
export { WhatsAppAdapter } from './adapters/whatsapp.js';
export { makeBaileysAuthState } from './adapters/whatsapp-auth.js';
export type { BaileysAuthState } from './adapters/whatsapp-auth.js';
