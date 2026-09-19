import { mountProjectsWs } from '@dash/management';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { mountChatWs } from '../chat-ws.js';
import { createLanMobileApp } from '../lan-mobile-app.js';
import { type GatewayManagementOptions, createGatewayManagementApp } from '../management-api.js';
import type { ResumableChatHub } from '../resumable-chat-hub.js';
import { type WsTicketStore, mountWsTicketRoute } from '../ws-ticket-store.js';

export interface GatewayApplicationOptions {
  management: GatewayManagementOptions;
  hub: ResumableChatHub;
  /** Create the restricted LAN surface; the caller supplies its TLS listener. */
  lan?: boolean;
  verboseWs?: boolean;
}

export interface GatewaySurface {
  app: Hono;
  injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket'];
}

export interface GatewayApplication {
  management: GatewaySurface;
  chat: GatewaySurface;
  lan?: GatewaySurface;
  wsTickets: WsTicketStore;
}

/** Assemble all transports against the same services, execution owner and ticket store. */
export function createGatewayApplication(options: GatewayApplicationOptions): GatewayApplication {
  const deps = options.management;
  const managementApp = createGatewayManagementApp(deps);
  const managementWs = createNodeWebSocket({ app: managementApp });
  if (deps.projectsDb) {
    mountProjectsWs(managementApp, {
      emitter: deps.projectsDb.emitter,
      token: deps.token,
      upgradeWebSocket: managementWs.upgradeWebSocket,
    });
  }
  // Mint before binding any listener. Relay-facing chat and LAN must redeem
  // from this exact store, regardless of which surface issued the ticket.
  const wsTickets = mountWsTicketRoute(managementApp);
  const createChatSurface = (app: Hono): GatewaySurface => {
    const ws = createNodeWebSocket({ app });
    mountChatWs(app, {
      execution: deps.execution,
      resumableChatHub: options.hub,
      token: deps.mobileToken,
      upgradeWebSocket: ws.upgradeWebSocket,
      eventLogStore: deps.conversationService.eventLog,
      verbose: options.verboseWs === true,
      speech: deps.speech,
      conversations: deps.conversationService,
      wsTickets,
    });
    return { app, injectWebSocket: ws.injectWebSocket };
  };
  return {
    management: { app: managementApp, injectWebSocket: managementWs.injectWebSocket },
    chat: createChatSurface(new Hono()),
    ...(options.lan ? { lan: createChatSurface(createLanMobileApp(managementApp)) } : {}),
    wsTickets,
  };
}
