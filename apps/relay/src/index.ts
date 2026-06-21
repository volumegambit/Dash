// Dash relay — self-hosted reverse-tunnel rendezvous between phones and gateways.
// The server bootstrap (config + createRelayServer) is wired in R2; this entry
// point is intentionally minimal until then.
export { encodeFrame, decodeFrame, type Frame } from './mux.js';
