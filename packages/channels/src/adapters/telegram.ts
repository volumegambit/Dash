import { Bot } from 'grammy';
import type { ChannelAdapter, ChannelHealth, MessageHandler, OutboundMessage } from '../types.js';

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private health: ChannelHealth = 'connecting';
  private healthHandlers: Array<(h: ChannelHealth) => void> = [];

  getHealth(): ChannelHealth {
    return this.health;
  }

  onHealthChange(handler: (health: ChannelHealth) => void): void {
    this.healthHandlers.push(handler);
  }

  private setHealth(h: ChannelHealth): void {
    if (this.health === h) return;
    this.health = h;
    for (const handler of this.healthHandlers) handler(h);
  }

  constructor(
    token: string,
    private allowedUsers: string[] = [],
  ) {
    this.bot = new Bot(token);

    this.bot.on('message:text', async (ctx) => {
      const senderId = String(ctx.from.id);
      const username = ctx.from.username ?? '';

      if (this.allowedUsers.length > 0) {
        const allowed = this.allowedUsers.some(
          (u) => u === senderId || u === username || u === `@${username}`,
        );
        if (!allowed) {
          await ctx.reply('Sorry, you are not authorized to use this bot.');
          return;
        }
      }

      const msg = {
        channelId: 'telegram',
        conversationId: String(ctx.chat.id),
        senderId,
        senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
        raw: ctx,
      };

      for (const handler of this.handlers) {
        await handler(msg);
      }
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    // Drop pending updates to avoid 409 conflict with stale polling sessions
    await this.bot.api.deleteWebhook({ drop_pending_updates: true });

    this.bot.catch((err) => {
      console.error('Telegram bot error:', err.message);
      this.setHealth('disconnected');
    });

    this.bot
      .start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          console.log(`Telegram bot @${botInfo.username} started (polling)`);
          this.setHealth('connected');
        },
      })
      .catch((err: unknown) => {
        console.error('[Telegram] Bot polling error:', err);
        this.setHealth('disconnected');
      });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.setHealth('disconnected');
    this.healthHandlers = [];
  }

  async send(conversationId: string, message: OutboundMessage): Promise<void> {
    await this.bot.api.sendMessage(Number(conversationId), message.text, {
      parse_mode: message.parseMode,
    });
  }
}
