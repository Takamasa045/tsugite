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
  pathname: string;
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

  return {
    href: url.href,
    origin: url.origin,
    host: url.host.toLowerCase(),
    hostname,
    pathname: url.pathname
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

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint host is not a public remote host",
      "endpoint"
    );
  }

  // Reject dotted-decimal lookalikes and reserved DNS labels used for private routing.
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
  // Common private/link-local reverse or local zones.
  return (
    hostname.endsWith(".lan")
    || hostname.endsWith(".home")
    || hostname.endsWith(".corp")
    || hostname.endsWith(".intranet")
  );
}

export type HostAllowlist = ReadonlySet<string>;

export function buildHostAllowlist(endpoints: readonly string[]): HostAllowlist {
  return new Set(endpoints.map((endpoint) => validateRegistryEndpoint(endpoint).hostname));
}

export function assertHostAllowed(hostname: string, allowlist: HostAllowlist): void {
  const host = normalizeHostname(hostname);
  assertPublicHostname(host);
  if (!allowlist.has(host)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.endpointForbidden,
      "endpoint host is outside the registry allowlist",
      "endpoint"
    );
  }
}

export type SafeFetch = typeof fetch;

/**
 * Fetch wrapper that refuses redirects and keeps the request host inside the
 * registry-derived allowlist. Never follows a redirect to an unlisted host.
 */
export function createAllowlistedFetch(
  allowlist: HostAllowlist,
  baseFetch: SafeFetch = fetch
): SafeFetch {
  return async (input, init) => {
    const url = requestUrl(input);
    assertHostAllowed(url.hostname, allowlist);

    const response = await baseFetch(input, {
      ...init,
      redirect: "manual"
    });

    if (response.status >= 300 && response.status < 400) {
      // Fail closed: never auto-follow redirects. If Location is present, still
      // require the target host to be on the registry allowlist, but always
      // surface a stable redirect-blocked issue code.
      const location = response.headers.get("location");
      if (location) {
        try {
          const next = new URL(location, url);
          assertHostAllowed(next.hostname, allowlist);
        } catch {
          throw agentServiceError(
            AGENT_SERVICE_ISSUE_CODES.endpointRedirect,
            "redirect target is not allowed",
            "endpoint"
          );
        }
      }
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
