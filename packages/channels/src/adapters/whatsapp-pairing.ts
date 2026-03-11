import makeWASocket, { DisconnectReason } from '@whiskeysockets/baileys';
import type { SecretStore } from '../types.js';
import { makeBaileysAuthState } from './whatsapp-auth.js';

export interface PairingCallbacks {
  onQr: (qrString: string) => void;
  onLinked: () => void;
  onError: (message: string) => void;
}

export async function startWhatsAppPairing(
  store: SecretStore,
  callbacks: PairingCallbacks,
): Promise<void> {
  const { state, saveCreds } = await makeBaileysAuthState(store, '');

  const MAX_QR_ROTATIONS = 5;
  let qrCount = 0;

  return new Promise<void>((resolve, reject) => {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCount++;
        if (qrCount > MAX_QR_ROTATIONS) {
          sock.end(undefined);
          const msg = 'QR code expired. Please try again.';
          callbacks.onError(msg);
          reject(new Error(msg));
          return;
        }
        callbacks.onQr(qr);
      }

      if (connection === 'open') {
        sock.end(undefined);
        callbacks.onLinked();
        resolve();
      }

      if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          const msg = 'WhatsApp session rejected. Try again.';
          callbacks.onError(msg);
          reject(new Error(msg));
        }
      }
    });
  });
}
