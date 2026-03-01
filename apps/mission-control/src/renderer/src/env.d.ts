/// <reference types="electron-vite/client" />

import type { MissionControlAPI } from '../../shared/ipc';

declare global {
  interface Window {
    api: MissionControlAPI;
  }
}
