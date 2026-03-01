import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';

let ws: WebSocket | undefined;

export function registerIpcHandlers(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('chat:connect', (_event, gatewayUrl: string) => {
    if (ws) {
      ws.close();
      ws = undefined;
    }

    ws = new WebSocket(gatewayUrl);

    ws.addEventListener('message', (event) => {
      const win = getWindow();
      if (!win) return;

      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          conversationId: string;
          text?: string;
          error?: string;
        };

        if (msg.type === 'response') {
          win.webContents.send('chat:response', msg.conversationId, msg.text ?? '');
        } else if (msg.type === 'error') {
          win.webContents.send('chat:error', msg.conversationId, msg.error ?? 'Unknown error');
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener('error', () => {
      const win = getWindow();
      if (win) {
        win.webContents.send('chat:error', '', 'WebSocket connection error');
      }
    });
  });

  ipcMain.handle('chat:disconnect', () => {
    if (ws) {
      ws.close();
      ws = undefined;
    }
  });

  ipcMain.handle('chat:send', (_event, conversationId: string, text: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to gateway');
    }
    ws.send(JSON.stringify({ type: 'message', conversationId, text }));
  });
}
