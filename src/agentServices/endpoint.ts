import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AGENT_SERVICE_ISSUE_CODES, agentServiceError } from "./errors.js";

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_LITERAL = /^\[?[0-9a-f:]+\]?$/i;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "::",
  "metadata.google.internal",
  "metadata"
]);

export type ValidatedEndpoint = {
  href: string;
  origin: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  /** Exact bind key: scheme + origin host/port + path (no query/hash). */
  canonical: string;
};

/**
 * Validate a registry endpoint string. Endpoints must be HTTPS public hosts
 * without credentials, query, hash, or IP/private/link-local targets.
 * Endpoint resolution is registry-only; callers must never accept arbitrary URLs.
 */
export function validateRegistryEndpoint(raw: string): ValidatedEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint is not a valid URL",
      "endpoint"
    );
  }

  if (url.protocol !== "https:") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint must use https",
      "endpoint"
    );
  }
  if (url.username || url.password) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint must not include username or password",
      "endpoint"
    );
  }
  if (url.hash) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint must not include a fragment",
      "endpoint"
    );
  }
  if (url.search) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint must not include a query string",
      "endpoint"
    );
  }
  if (!url.hostname) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointInvalid,
      "endpoint host is required",
      "endpoint"
    );
  }

  const hostname = normalizeHostname(url.hostname);
  assertPublicHostname(hostname);

  const pathname = url.pathname || "/";
  const port = url.port || "443";
  // Prefer URL.normalization for default HTTPS port stripping in href/origin.
  const canonicalUrl = new URL(url.href);
  canonicalUrl.hash = "";
  canonicalUrl.search = "";
  const canonical = `${canonicalUrl.origin}${pathname === "" ? "/" : pathname}`;

  return {
    href: canonicalUrl.href,
    origin: canonicalUrl.origin,
    host: canonicalUrl.host.toLowerCase(),
    hostname,
    port,
    pathname,
    canonical
  };
}

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/\.$/, "").toLowerCase();
}

export function assertPublicHostname(hostname: string): void {
  const host = normalizeHostname(hostname);

  if (!host || host.includes(" ") || host.includes("\\")) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint host is forbidden",
      "endpoint"
    );
  }

  if (IPV4_LITERAL.test(host) || isIpv6Literal(host)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint must not use an IP literal",
      "endpoint"
    );
  }

  if (
    BLOCKED_HOSTNAMES.has(host)
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
  ) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint host is not a public remote host",
      "endpoint"
    );
  }

  if (host === "broadcasthost" || host.startsWith("0.") || isPrivateDnsLabel(host)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint host is not a public remote host",
      "endpoint"
    );
  }
}

function isIpv6Literal(hostname: string): boolean {
  const trimmed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return trimmed.includes(":") && IPV6_LITERAL.test(trimmed);
}

function isPrivateDnsLabel(hostname: string): boolean {
  return (
    hostname.endsWith(".lan")
    || hostname.endsWith(".home")
    || hostname.endsWith(".corp")
    || hostname.endsWith(".intranet")
  );
}

/** Exact endpoint allowlist (scheme/origin/port/path). Not hostname-only. */
export type EndpointAllowlist = ReadonlySet<string>;

export function buildEndpointAllowlist(endpoints: readonly string[]): EndpointAllowlist {
  return new Set(endpoints.map((endpoint) => validateRegistryEndpoint(endpoint).canonical));
}

export function requestEndpointCanonical(url: URL): string {
  if (url.protocol !== "https:") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "request must use https",
      "endpoint"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "request endpoint must not include credentials, query, or fragment",
      "endpoint"
    );
  }
  const hostname = normalizeHostname(url.hostname);
  assertPublicHostname(hostname);
  const pathname = url.pathname || "/";
  return `${url.origin}${pathname}`;
}

export function assertEndpointAllowed(url: URL, allowlist: EndpointAllowlist): void {
  const canonical = requestEndpointCanonical(url);
  if (!allowlist.has(canonical)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "request endpoint is outside the registry exact-endpoint allowlist",
      "endpoint"
    );
  }
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export async function defaultDnsResolver(hostname: string): Promise<readonly string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * True when the address is globally routable public unicast.
 * Rejects loopback, private, link-local, CGNAT, ULA, multicast, unspecified,
 * documentation, and other special-use ranges.
 */
export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;

  // 0.0.0.0/8 unspecified / this network
  if (a === 0) return false;
  // 10.0.0.0/8 private
  if (a === 10) return false;
  // 127.0.0.0/8 loopback
  if (a === 127) return false;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 IETF protocol assignments (includes 192.0.0.0/29 etc.)
  if (a === 192 && b === 0 && c === 0) return false;
  // 192.0.2.0/24 documentation TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return false;
  // 192.88.99.0/24 6to4 relay anycast (special-use)
  if (a === 192 && b === 88 && c === 99) return false;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 198.51.100.0/24 documentation TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return false;
  // 203.0.113.0/24 documentation TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return false;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  if (a >= 224) return false;

  return true;
}

function embeddedIpv4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPublicIpv6(address: string): boolean {
  const normalized = expandIpv6(address);
  if (!normalized) return false;

  // :: / ::1
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0000") return false;
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return false;

  const first = Number.parseInt(normalized.slice(0, 4), 16);
  const second = Number.parseInt(normalized.slice(5, 9), 16);
  const third = Number.parseInt(normalized.slice(10, 14), 16);
  const fourth = Number.parseInt(normalized.slice(15, 19), 16);
  const seventh = Number.parseInt(normalized.slice(30, 34), 16);
  const eighth = Number.parseInt(normalized.slice(35, 39), 16);

  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return false;
  // fec0::/10 deprecated site-local
  if ((first & 0xffc0) === 0xfec0) return false;
  // fc00::/7 unique local
  if ((first & 0xfe00) === 0xfc00) return false;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return false;
  // 100::/64 discard-only (RFC 6666)
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return false;
  // 2001:db8::/32 documentation
  if (first === 0x2001 && second === 0x0db8) return false;
  // 2001:2::/48 benchmarking (RFC 5180) — only third hextet === 0
  if (first === 0x2001 && second === 0x0002 && third === 0) return false;
  // 2001:10::/28 ORCHID v1 and 2001:20::/28 ORCHIDv2 (deprecated special-use)
  if (
    first === 0x2001
    && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)
  ) {
    return false;
  }
  // 3fff::/20 documentation (RFC 9637): first === 0x3fff && top 4 bits of second === 0
  if (first === 0x3fff && (second & 0xf000) === 0) return false;
  // NAT64 local-use 64:ff9b:1::/48 (RFC 8215) — not expected on fixed Cloudflare host DNS;
  // reject the whole prefix fail-closed rather than evaluating embeds.
  if (first === 0x0064 && second === 0xff9b && third === 0x0001) return false;
  // NAT64 well-known prefix 64:ff9b::/96 — evaluate embedded IPv4
  if (
    first === 0x0064
    && second === 0xff9b
    && third === 0
    && fourth === 0
    && normalized.startsWith("0064:ff9b:0000:0000:0000:0000:")
  ) {
    return isPublicIpv4(embeddedIpv4FromHextets(seventh, eighth));
  }
  // 6to4 2002::/16 — evaluate embedded IPv4 from the following 32 bits
  if (first === 0x2002) {
    return isPublicIpv4(embeddedIpv4FromHextets(second, third));
  }
  // ::ffff:0:0/96 IPv4-mapped — evaluate embedded IPv4
  if (normalized.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    return isPublicIpv4(embeddedIpv4FromHextets(seventh, eighth));
  }
  // Deprecated IPv4-compatible ::/96 (non-mapped) — re-evaluate embedded IPv4 so
  // private/loopback embeds are rejected (mixed dotted-quad and hex forms).
  if (normalized.startsWith("0000:0000:0000:0000:0000:0000:")) {
    return isPublicIpv4(embeddedIpv4FromHextets(seventh, eighth));
  }

  return true;
}

function expandIpv6(address: string): string | null {
  let trimmed = address.toLowerCase().replace(/^\[|\]$/g, "");
  // Mixed form: convert a trailing IPv4 dotted quad into two hextets.
  const v4Tail = trimmed.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const octets = v4Tail[2].split(".").map((part) => Number(part));
    if (
      octets.length !== 4
      || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    trimmed = `${v4Tail[1]}${hi}:${lo}`;
  } else if (trimmed.includes(".")) {
    return null;
  }

  const sides = trimmed.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":") : [];
  const tail = sides.length === 2 ? (sides[1] ? sides[1].split(":") : []) : [];
  if (sides.length === 1) {
    const parts = trimmed.split(":");
    if (parts.length !== 8) return null;
    return parts.map((part) => part.padStart(4, "0")).join(":");
  }
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const middle = Array.from({ length: missing }, () => "0000");
  const parts = [...head, ...middle, ...tail].map((part) => {
    if (!part) return "0000";
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return part.padStart(4, "0");
  });
  if (parts.some((part) => part == null)) return null;
  return parts.join(":");
}

/**
 * Resolve hostname and require every address to be public.
 * Note: DNS answers can change between check and connect (TOCTOU). The primary
 * trust boundary for this MVP remains the fixed bundled Cloudflare/Workers hosts.
 */
export async function assertResolvedAddressesPublic(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver
): Promise<void> {
  const host = normalizeHostname(hostname);
  assertPublicHostname(host);

  let addresses: readonly string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.network,
      "DNS lookup failed for agent service endpoint",
      "endpoint"
    );
  }

  if (!addresses.length) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointDnsPrivate,
      "DNS lookup returned no addresses",
      "endpoint"
    );
  }

  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.endpointDnsPrivate,
        "resolved endpoint address is not a public IP",
        "endpoint"
      );
    }
  }
}

export type SafeFetch = typeof fetch;

export type AllowlistedFetchOptions = {
  dnsResolver?: DnsResolver;
  /** When true, skip per-request DNS checks (tests that inject pure URL policy). */
  skipDns?: boolean;
};

/**
 * Fetch wrapper that binds requests to exact registry endpoints, refuses all
 * redirects, and (by default) re-checks DNS publicness before each request.
 */
export function createAllowlistedFetch(
  allowlist: EndpointAllowlist,
  baseFetch: SafeFetch = fetch,
  options: AllowlistedFetchOptions = {}
): SafeFetch {
  const resolver = options.dnsResolver ?? defaultDnsResolver;
  const skipDns = options.skipDns === true;

  return async (input, init) => {
    const url = requestUrl(input);
    assertEndpointAllowed(url, allowlist);

    if (!skipDns) {
      await assertResolvedAddressesPublic(url.hostname, resolver);
    }

    const response = await baseFetch(input, {
      ...init,
      redirect: "manual"
    });

    if (response.status >= 300 && response.status < 400) {
      // Fail closed: never auto-follow redirects, even to another allowlisted URL.
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.endpointRedirect,
        "HTTP redirects are not followed for agent service endpoints",
        "endpoint"
      );
    }

    return response;
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}
