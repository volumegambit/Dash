export type MobileRouteTarget =
  | { kind: 'mobile'; version: 1 | 2; pathname: string }
  | { kind: 'non_mobile'; pathname: string }
  | { kind: 'rejected' };

const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

function hasDotSegment(pathname: string): boolean {
  return pathname.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function decodeLayers(pathname: string): string | null {
  let decoded = pathname;
  for (let depth = 0; depth < 16; depth++) {
    if (ENCODED_SEPARATOR.test(decoded) || decoded.includes('\\') || hasDotSegment(decoded)) {
      return null;
    }
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  return null;
}

/** Classify the original HTTP request target before URL/path normalization. */
export function classifyMobileRouteTarget(requestTarget: string): MobileRouteTarget {
  if (requestTarget.includes('#')) return { kind: 'rejected' };
  const rawPathname = requestTarget.split('?', 1)[0];
  if (!rawPathname.startsWith('/')) return { kind: 'rejected' };
  const pathname = decodeLayers(rawPathname);
  if (pathname === null) return { kind: 'rejected' };
  if (pathname === '/mobile/v1' || pathname.startsWith('/mobile/v1/')) {
    return { kind: 'mobile', version: 1, pathname };
  }
  if (pathname === '/mobile/v2' || pathname.startsWith('/mobile/v2/')) {
    return { kind: 'mobile', version: 2, pathname };
  }
  return { kind: 'non_mobile', pathname };
}

/** Prefer the Node adapter's raw target; fall back only for in-process Hono requests. */
export function mobileRequestTarget(normalizedUrl: string, incomingUrl?: string): string {
  if (incomingUrl !== undefined) return incomingUrl;
  const url = new URL(normalizedUrl);
  return `${url.pathname}${url.search}`;
}
