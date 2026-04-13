import { Bot } from 'grammy';
import type { ReactionTypeEmoji } from 'grammy/types';
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

/**
 * Acknowledgement behaviors the adapter performs between receiving a user
 * message and sending the agent's reply.
 *
 * - `reaction`: a single emoji posted immediately on the inbound message.
 *   Telegram's non-premium bot API only accepts a fixed set of emoji
 *   reactions (👀, 👍, ❤️, 🔥, 🎉, etc.); unsupported values will be
 *   rejected by Telegram at call time. Set to `false` to disable.
 * - `typing`: whether to fire a repeating `sendChatAction('typing')` loop
 *   from message-receipt until `send()` is called for the same conversation,
 *   so Telegram's "typing…" indicator stays visible while the agent thinks.
 *
 * Both default to enabled with 👀 for the reaction.
 */
export interface TelegramAckOptions {
  reaction?: string | false;
  typing?: boolean;
}

/** Telegram's typing action decays after ~5s, so refresh slightly faster. */
const TYPING_REFRESH_MS = 4_000;

/**
 * Hard cap on how long we'll keep firing typing indicators for a single
 * conversation. Protects against a missing `send()` call leaking a timer —
 * e.g. if the agent path silently drops the turn.
 */
const TYPING_MAX_MS = 120_000;

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private handlers: MessageHandler[] = [];
  private health: ChannelHealth = 'connecting';
  private healthHandlers: Array<(h: ChannelHealth) => void> = [];
  private readonly getAllowedUsers: () => string[];
  private readonly ackReaction: string | false;
  private readonly ackTyping: boolean;
  /**
   * Active typing loops keyed by conversationId. One entry = one refresh
   * interval + its paired max-duration safety timeout. Both must be cleared
   * together when the agent's reply arrives or the safety cap expires.
   */
  private typingLoops = new Map<
    string,
    { refresh: ReturnType<typeof setInterval>; expiry: ReturnType<typeof setTimeout> }
  >();

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
    allowedUsers: TelegramAllowedUsers = [],
    ackOptions: TelegramAckOptions = {},
  ) {
    // Normalize once — the hot path just calls `this.getAllowedUsers()`.
    this.getAllowedUsers = typeof allowedUsers === 'function' ? allowedUsers : () => allowedUsers;
    this.ackReaction = ackOptions.reaction ?? '👀';
    this.ackTyping = ackOptions.typing ?? true;
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

      // Fire acknowledgements before handing off. Both are best-effort: a
      // failure here must never block the handler chain or flip channel
      // health, since the transport itself is fine — Telegram can reject a
      // reaction for message-too-old or missing-permission and the agent
      // should still run normally.
      this.sendAck(Number(ctx.chat.id), Number(ctx.message.message_id), conversationId);

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
    // Clear any in-flight ack timers so they don't outlive the bot.
    for (const conversationId of this.typingLoops.keys()) {
      this.stopTypingLoop(conversationId);
    }
    await this.bot.stop();
    this.setHealth('disconnected');
    this.healthHandlers = [];
  }

  async send(conversationId: string, message: OutboundMessage): Promise<void> {
    // The agent's reply is about to land — Telegram's own message will
    // clear the typing indicator visually, but we still need to cancel the
    // refresh timer so it stops re-arming the action. Do this BEFORE the
    // network call so a rejected sendMessage doesn't leak the loop.
    this.stopTypingLoop(conversationId);
    await this.bot.api.sendMessage(Number(conversationId), message.text, {
      parse_mode: message.parseMode,
    });
  }

  // ── Acknowledgement helpers ─────────────────────────────────────────────

  /**
   * Fires the configured reaction + starts the typing loop. Called from the
   * `message:text` handler after auth passes. Both branches are independent
   * and isolated so a failure in one doesn't sabotage the other.
   */
  private sendAck(chatId: number, messageId: number, conversationId: string): void {
    if (this.ackReaction) {
      // Telegram's types narrow `emoji` to a fixed union (the 71 allowed
      // reaction emoji). We accept any string at the config boundary and
      // let Telegram reject unsupported values at call time — more useful
      // error than a compile-time rejection, and keeps the public API
      // simple. Cast is contained to this single call site.
      const emoji = this.ackReaction as ReactionTypeEmoji['emoji'];
      // Fire-and-forget — this is an acknowledgement, not a correctness
      // signal. We `void` the promise so the missing await isn't a lint
      // violation and log non-fatally on failure.
      void this.bot.api
        .setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }])
        .catch((err: unknown) => {
          console.warn(
            `[telegram] setMessageReaction failed conversationId=${conversationId} emoji=${emoji}:`,
            err instanceof Error ? err.message : err,
          );
        });
    }
    if (this.ackTyping) {
      this.startTypingLoop(chatId, conversationId);
    }
  }

  /**
   * Start (or restart) a typing-indicator loop for a conversation. Fires
   * `sendChatAction('typing')` immediately and every {@link TYPING_REFRESH_MS}
   * until `send()` is called for this conversation or the safety cap at
   * {@link TYPING_MAX_MS} expires. Restarting an existing loop is safe — we
   * clear the previous one first so timers don't pile up.
   */
  private startTypingLoop(chatId: number, conversationId: string): void {
    this.stopTypingLoop(conversationId);

    const tick = (): void => {
      void this.bot.api.sendChatAction(chatId, 'typing').catch((err: unknown) => {
        // One failure is usually transient (rate limit, network blip). But
        // if the loop itself is wedged we stop rather than spam warnings.
        console.warn(
          `[telegram] sendChatAction failed conversationId=${conversationId}, stopping typing loop:`,
          err instanceof Error ? err.message : err,
        );
        this.stopTypingLoop(conversationId);
      });
    };

    tick();
    const refresh = setInterval(tick, TYPING_REFRESH_MS);
    const expiry = setTimeout(() => this.stopTypingLoop(conversationId), TYPING_MAX_MS);
    this.typingLoops.set(conversationId, { refresh, expiry });
  }

  /** Idempotent: clears timers and drops the map entry if one exists. */
  private stopTypingLoop(conversationId: string): void {
    const loop = this.typingLoops.get(conversationId);
    if (!loop) return;
    clearInterval(loop.refresh);
    clearTimeout(loop.expiry);
    this.typingLoops.delete(conversationId);
  }
}
