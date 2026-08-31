export const config = {
  clerkPublishableKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string,
  controlPlaneUrl: import.meta.env.VITE_CONTROL_PLANE_URL as string,
  /** Domain the relay is served under; a gateway's browser base URLs are
   * `https://<subdomain>.<relayDomain>/mobile/v1` (REST) and
   * `wss://<subdomain>.<relayDomain>/ws/chat` (WS) — see Shell.tsx. */
  relayDomain: import.meta.env.VITE_RELAY_DOMAIN as string,
};
