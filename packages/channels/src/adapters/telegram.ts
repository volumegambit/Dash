import { Bot } from 'grammy';
import type { ChannelAdapter, ChannelHealth, MessageHandler, OutboundMessage } from '../types.js';

/**
 * `allowedUsers` may be provided as a static array (snapshot at construction
 * time — suitable for tests and one-shot scripts) or as a zero-arg function
 * (called on every inbound message, so live edits to the list take effect
 * without restarting the adapter). The function form is what the gateway
 * uses: it closes over a `ChannelRegistry` lookup so runtime `PUT /channels`
 * edits propagate immediately — same pull-based pattern as the routing
 * resolver in `createDynamicGateway`.
 *
 * An empty list (or a function that returns one) means "no adapter-level
 * filter" — every message is forwarded to registered handlers, where the
 * gateway's rule-level `allowList` / `globalDenyList` provide finer-grained
 * control. Entries may be numeric sender IDs, bare usernames, or `@username`
 * — all three are matched exactly.
 */
export type TelegramAllowedUsers = string[] | (() => string[]);

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private health: ChannelHealth = 'connecting';
  private healthHandlers: Array<(h: ChannelHealth) => void> = [];
  private readonly getAllowedUsers: () => string[];

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

  constructor(token: string, allowedUsers: TelegramAllowedUsers = []) {
    // Normalize once — the hot path just calls `this.getAllowedUsers()`.
    this.getAllowedUsers =
      typeof allowedUsers === 'function' ? allowedUsers : () => allowedUsers;
    this.bot = new Bot(token);

    this.bot.on('message:text', async (ctx) => {
      const senderId = String(ctx.from.id);
      const username = ctx.from.username ?? '';
      const conversationId = String(ctx.chat.id);

      // Resolve the allow-list fresh for every message so PUT /channels
      // edits take effect without adapter restart.
      let allowList: string[];
      try {
        allowList = this.getAllowedUsers();
      } catch (err) {
        // A resolver that throws is a bug in the caller — fail closed
        // (drop the message) rather than letting it escape into grammy.
        console.error(
          `[telegram] getAllowedUsers resolver threw for conversation=${conversationId}:`,
          err instanceof Error ? (err.stack ?? err.message) : err,
        );
        return;
      }

      if (allowList.length > 0) {
        const allowed = allowList.some(
          (u) => u === senderId || u === username || u === `@${username}`,
        );
        if (!allowed) {
          console.warn(
            `[telegram] unauthorized sender rejected senderId=${senderId} username=${username || '-'} conversationId=${conversationId}`,
          );
          try {
            await ctx.reply('Sorry, you are not authorized to use this bot.');
          } catch (err) {
            console.warn(
              `[telegram] failed to send unauthorized reply conversationId=${conversationId}:`,
              err instanceof Error ? err.message : err,
            );
          }
          return;
        }
      }

      const msg = {
        channelId: 'telegram',
        conversationId,
        senderId,
        senderName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ''),
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
        raw: ctx,
      };

      // Isolate each downstream handler so one bad handler does not
      // crash the grammy middleware (which would flip health to
      // 'disconnected' via bot.catch, a misleading signal since the
      // Telegram transport itself is fine).
      for (const handler of this.handlers) {
        try {
          await handler(msg);
        } catch (err) {
          console.error(
            `[telegram] message handler threw senderId=${senderId} conversationId=${conversationId}:`,
            err instanceof Error ? (err.stack ?? err.message) : err,
          );
        }
      }
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    // Drop pending updates to avoid 409 conflict with stale polling sessions.
    // Failures here are non-fatal — Telegram may rate-limit or temporarily
    // reject the call, but bot.start() will surface a real 409 if a stale
    // session actually exists.
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch (err) {
      console.warn(
        '[telegram] deleteWebhook at startup failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }

    this.bot.catch((err) => {
      console.error(
        '[telegram] bot.catch error:',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
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
