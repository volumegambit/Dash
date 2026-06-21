// Dash relay — self-hosted reverse-tunnel rendezvous between phones and gateways.
// This barrel is the library surface: pure re-exports, no side effects (the
// executable runner lives in main.ts, so importing `@dash/relay` never starts a
// server). The frame codec, the server factory, and the auth helpers are public
// so the gateway-side e2e test and the deploy runner can consume them.
export { encodeFrame, decodeFrame, type Frame } from './mux.js';
export {
  createRelayServer,
  type RelayServer,
  type RelayLimits,
  type RelayServerOptions,
  type RelayAdminConfig,
} from './relay-server.js';
export { staticRelayAuth, credentialStoreAuth, safeEqual, type RelayDeps } from './auth.js';
export { PairingCredentialStore } from './credential-store.js';
