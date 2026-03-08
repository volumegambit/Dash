import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import type { ConnectionState, WASocket } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import type { ChannelAdapter, MessageHandler, OutboundMessage, SecretStore } from '../types.js';
import { makeBaileysAuthState } from './whatsapp-auth.js';

class InlineFileStore implements SecretStore {
  private readonly filePath: string;
  constructor(dir: string) {
    this.filePath = join(dir, 'secrets.json');
  }
  private async load(): Promise<Record<string, string>> {
    if (!existsSync(this.filePath)) return {};
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, string>;
  }
  private async save(data: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }
  async get(key: string): Promise<string | null> {
    return (await this.load())[key] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = value;
    await this.save(data);
  }
  async delete(key: string): Promise<void> {
    const data = await this.load();
    delete data[key];
    await this.save(data);
  }
  async list(): Promise<string[]> {
    return Object.keys(await this.load());
  }
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = 'whatsapp';
  private handlers: MessageHandler[] = [];
  private sock: WASocket | null = null;
  private stopped = false;

  constructor(
    private readonly initialAuthState: Record<string, string>,
    private readonly authStateDir: string,
  ) {}

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Ensure auth directory exists
    await mkdir(this.authStateDir, { recursive: true });

    // Seed the inline file store with the initial auth state
    const store = new InlineFileStore(this.authStateDir);
    for (const [key, value] of Object.entries(this.initialAuthState)) {
      await store.set(key, value);
    }

    // Bootstrap Baileys auth state
    const { state, saveCreds } = await makeBaileysAuthState(store, '');

    // Create the Baileys socket
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });
    this.sock = sock;

    // Persist credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection state changes
    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
          if (!err) process.stdout.write(str + '\n');
        });
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          if (this.stopped) return;
          this.start().catch((err) => console.error('[WhatsApp] Reconnect failed:', err));
        } else {
          console.warn('[WhatsApp] Logged out. Please re-authenticate.');
        }
      }
    });

    // Handle incoming messages
    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }: { messages: unknown[]; type: string }) => {
        if (type !== 'notify') return;

        for (const raw of messages) {
          const msg = raw as {
            key: { remoteJid?: string; fromMe?: boolean; participant?: string };
            message?: {
              conversation?: string;
              extendedTextMessage?: { text?: string };
              [key: string]: unknown;
            };
            pushName?: string;
            messageTimestamp?: number | bigint;
          };

          const { key } = msg;
          if (key.fromMe) continue;

          const remoteJid = key.remoteJid;
          if (!remoteJid) continue;

          // senderId: participant for groups, remoteJid for DMs
          const senderId = key.participant ?? remoteJid;

          // Extract text
          const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? null;

          if (text === null) {
            console.warn(`[WhatsApp] Skipping non-text message from ${senderId}`);
            continue;
          }

          const ts = msg.messageTimestamp;
          const timestamp = new Date(typeof ts === 'bigint' ? Number(ts) * 1000 : (ts ?? 0) * 1000);

          const inbound = {
            channelId: 'whatsapp',
            conversationId: remoteJid,
            senderId,
            senderName: msg.pushName ?? senderId,
            text,
            timestamp,
            raw: msg,
          };

          for (const handler of this.handlers) {
            await handler(inbound);
          }
        }
      },
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async send(conversationId: string, message: OutboundMessage): Promise<void> {
    if (!this.sock) {
      throw new Error('[WhatsApp] Adapter not started');
    }
    await this.sock.sendMessage(conversationId, { text: message.text });
  }
}
