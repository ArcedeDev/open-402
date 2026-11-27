import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import validator from "agent-json-validate";
import ipaddr from "ipaddr.js";

export interface CrawlResult {
  success: boolean;
  manifest?: Record<string, unknown>;
  error?: string;
}

export function isPublicDomain(domain: string): boolean {
  const name = domain.toLowerCase();
  if (name.length > 253 || isIP(name) || !name.includes(".")) return false;
  if (!name.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  try { if (isIP(new URL(`https://${name}`).hostname)) return false; }
  catch { return false; }
  const reserved = ["localhost", "local", "internal", "test", "invalid", "example", "corp", "lan", "example.com", "example.net", "example.org"];
  return !reserved.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== "unicast") return false;
  // IPv6 default-unicast also includes unallocated and local translation space.
  return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
}

export function validateManifest(value: unknown, domain: string): CrawlResult {
  try {
    const result = validator.validate(value, `https://${domain}/.well-known/agent.json`);
    if (!result.valid) return { success: false, error: "invalid_manifest" };
    const manifest = value as Record<string, unknown>;
    if (typeof manifest.origin !== "string" || manifest.origin.toLowerCase() !== domain.toLowerCase()) {
      return { success: false, error: "origin_mismatch" };
    }
    const payments = manifest.payments as Record<string, Record<string, unknown>> | undefined;
    const configs = [...Object.values(payments ?? {}), manifest.x402].filter(Boolean) as Record<string, unknown>[];
    if (configs.some((config) => Array.isArray(config.networks) && config.networks.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)))) {
      return { success: false, error: "invalid_payment_networks" };
    }
    return { success: true, manifest };
  } catch {
    return { success: false, error: "invalid_manifest" };
  }
}

export interface CrawlOptions {
  timeoutMs?: number;
  /** Accept a 200 body whatever its content type (the caller parses it). Default false. */
  anyContentType?: boolean;
  /** Follow a redirect only to the same host or its `www.` twin. Default false. */
  sameHostRedirect?: boolean;
  maxBytes?: number;
  request?: typeof request;
  lookup?: typeof lookup;
}

export interface PublicFetchResult {
  success: boolean;
  body?: string;
  error?: string;
}

/**
 * GET one JSON document from a public HTTPS origin, with the crawler's guards: public names and
 * addresses only (checked on the socket's own lookup), port 443, one redirect, a byte cap and a
 * timeout. Only a 200 JSON response yields a body.
 */
export async function fetchPublicJson(domain: string, path: string, options: CrawlOptions = {}): Promise<PublicFetchResult> {
  if (!isPublicDomain(domain) || !path.startsWith("/")) return { success: false, error: "blocked" };
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 100_000;
  const send = options.request ?? request;
  const resolveHost = options.lookup ?? lookup;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  async function read(url: URL): Promise<{ location?: string; body?: string }> {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !isPublicDomain(url.hostname)) {
      throw new Error("blocked");
    }
    return new Promise((resolve, reject) => {
      const req = send(url, {
        agent: false,
        signal: controller.signal,
        headers: { Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": "Open402DirectoryCrawler/1.0" },
        // Validate the addresses used by this socket, not a separate DNS preflight.
        lookup(host, lookupOptions, callback) {
          resolveHost(host, { all: true, verbatim: true }).then((addresses) => {
            if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
              callback(new Error("blocked_address"), "", 4);
              return;
            }
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          }, (error) => callback(error, "", 4));
        },
      }, (res) => {
        res.on("error", reject);
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.destroy();
          if (location) resolve({ location });
          else reject(new Error("redirect_no_location"));
          return;
        }
        if (status !== 200 || (!options.anyContentType && !String(res.headers["content-type"] ?? "").toLowerCase().includes("json"))) {
          res.destroy();
          reject(new Error(status !== 200 ? `HTTP ${status}` : "not_json"));
          return;
        }
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          res.destroy();
          reject(new Error("unsupported_encoding"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            res.destroy(new Error("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
        res.on("aborted", () => reject(new Error("body_aborted")));
      });
      req.on("error", reject);
      req.end();
    });
  }

  try {
    const url = new URL(`https://${domain}${path}`);
    let response = await read(url);
    if (response.location) {
      const next = new URL(response.location, url);
      const bare = (host: string) => host.replace(/^www\./, "");
      if (options.sameHostRedirect && bare(next.hostname) !== bare(url.hostname)) return { success: false, error: "cross_host_redirect" };
      response = await read(next);
    }
    if (response.location) return { success: false, error: "too_many_redirects" };
    return { success: true, body: response.body ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const known = /^(blocked|blocked_address|too_large|body_aborted|redirect_no_location|not_json|unsupported_encoding|HTTP \d+)$/;
    return { success: false, error: controller.signal.aborted ? "timeout" : known.test(message) ? message : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function crawlDomain(domain: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  if (!isPublicDomain(domain)) return { success: false, error: "blocked" };
  const response = await fetchPublicJson(domain, "/.well-known/agent.json", options);
  if (!response.success) return { success: false, error: response.error };
  let value: unknown;
  try { value = JSON.parse(response.body ?? ""); }
  catch { return { success: false, error: "invalid_json" }; }
  return validateManifest(value, domain);
}

/**
 * Evidence that an unclaimed listing is a live x402 service, in this order: its root answers with
 * an HTTP 402 challenge; its `/.well-known/x402` discovery document is a JSON object with a positive
 * integer `x402Version`; or one of the first three resources that document lists on the same host
 * answers with an HTTP 402 challenge. Every request goes through the guarded fetch above, and a
 * redirect to another host does not count. At most five requests are made.
 */
export async function probeX402Discovery(domain: string, overrides: CrawlOptions = {}): Promise<{ success: boolean; error?: string }> {
  // Evidence must come from the listed host itself, not from wherever it redirects.
  const options: CrawlOptions = { sameHostRedirect: true, ...overrides };
  const root = await fetchPublicJson(domain, "/", options);
  if (root.error === "HTTP 402") return { success: true };
  // Discovery files list every resource, so they run larger than manifests.
  const response = await fetchPublicJson(domain, "/.well-known/x402", { maxBytes: 1_000_000, anyContentType: true, ...options });
  if (!response.success) return { success: false, error: response.error };
  let value: unknown;
  try { value = JSON.parse(response.body ?? ""); }
  catch { return { success: false, error: "invalid_json" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false, error: "no_x402_version" };
  const version = (value as Record<string, unknown>).x402Version;
  if (Number.isSafeInteger(version) && (version as number) >= 1) return { success: true };

  const paths = new Set<string>();
  for (const match of (response.body ?? "").matchAll(/https:\/\/[^\s"'<>\\]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === domain && url.pathname !== "/" && !url.pathname.startsWith("/.well-known/")) paths.add(url.pathname);
    } catch { /* not a URL */ }
    if (paths.size === 3) break;
  }
  for (const path of paths) {
    if ((await fetchPublicJson(domain, path, options)).error === "HTTP 402") return { success: true };
  }
  return { success: false, error: "no_x402_version" };
}
