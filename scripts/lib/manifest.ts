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
  /** Read a 402 response (any content type) instead of failing with "HTTP 402". */
  accept402?: boolean;
  /** Send an empty JSON object as a POST, as an x402 client's unpaid first request does. */
  emptyPost?: boolean;
  maxBytes?: number;
  request?: typeof request;
  lookup?: typeof lookup;
}

export interface PublicFetchResult {
  success: boolean;
  /** 200, or 402 when `accept402` is set. */
  status?: number;
  body?: string;
  /** The `PAYMENT-REQUIRED` header of a 402 response, when `accept402` is set. */
  paymentRequired?: string;
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

  async function read(url: URL): Promise<{ location?: string; body?: string; status?: number; paymentRequired?: string }> {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !isPublicDomain(url.hostname)) {
      throw new Error("blocked");
    }
    return new Promise((resolve, reject) => {
      const req = send(url, {
        agent: false,
        signal: controller.signal,
        method: options.emptyPost ? "POST" : "GET",
        headers: {
          Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": "Open402DirectoryCrawler/1.0",
          ...(options.emptyPost ? { "Content-Type": "application/json", "Content-Length": "2" } : {}),
        },
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
        const challenge = status === 402 && options.accept402 === true;
        if (!challenge && (status !== 200 || (!options.anyContentType && !String(res.headers["content-type"] ?? "").toLowerCase().includes("json")))) {
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
        const header = res.headers["payment-required"];
        res.on("end", () => resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status,
          ...(challenge && typeof header === "string" ? { paymentRequired: header } : {}),
        }));
        res.on("aborted", () => reject(new Error("body_aborted")));
      });
      req.on("error", reject);
      req.end(options.emptyPost ? "{}" : undefined);
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
    return {
      success: true,
      status: response.status ?? 200,
      body: response.body ?? "",
      ...(response.paymentRequired !== undefined ? { paymentRequired: response.paymentRequired } : {}),
    };
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

/** A JSON value that reads as an x402 payment requirement: an integer version and something to pay. */
function isPaymentRequirement(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { x402Version, accepts } = value as Record<string, unknown>;
  return Number.isSafeInteger(x402Version) && (x402Version as number) >= 1
    && Array.isArray(accepts) && accepts.length > 0
    && accepts.every((option) => option !== null && typeof option === "object" && !Array.isArray(option));
}

/**
 * True for a 402 that carries an x402 challenge: a `PAYMENT-REQUIRED` header holding base64 JSON
 * (x402 v2), or a JSON body (x402 v1), naming a version and at least one payment option. A bare
 * 402, such as a host's "deployment disabled" or "payment required" page, does not count.
 */
export function isX402Challenge(response: PublicFetchResult): boolean {
  if (!response.success || response.status !== 402) return false;
  if (response.paymentRequired) {
    try {
      if (isPaymentRequirement(JSON.parse(Buffer.from(response.paymentRequired, "base64").toString("utf8")))) return true;
    } catch { /* not base64 JSON */ }
  }
  try { return isPaymentRequirement(JSON.parse(response.body ?? "")); }
  catch { return false; }
}

/**
 * Evidence that an unclaimed listing is a live x402 service: its root, or one of the first three
 * resources its `/.well-known/x402` discovery document lists on the same host, answers with an
 * x402 challenge (see isX402Challenge). A discovery document alone is not enough. Every request
 * goes through the guarded fetch above, a redirect to another host does not count, a resource that
 * refuses GET with 405 is asked once more with an empty JSON POST, and at most eight requests are made.
 */
/** Errors that say nothing about the service itself: worth another try later. */
export function isTransientFetchError(error: string | undefined): boolean {
  return error === "timeout" || error === "request_failed" || error === "body_aborted" || /^HTTP (429|5\d\d)$/.test(error ?? "");
}

export async function probeX402Discovery(domain: string, overrides: CrawlOptions = {}): Promise<{ success: boolean; error?: string; transient?: boolean }> {
  // Evidence must come from the listed host itself, not from wherever it redirects.
  const options: CrawlOptions = { sameHostRedirect: true, accept402: true, ...overrides };
  if (isX402Challenge(await fetchPublicJson(domain, "/", options))) return { success: true };
  // Discovery files list every resource, so they run larger than manifests.
  const response = await fetchPublicJson(domain, "/.well-known/x402", { maxBytes: 1_000_000, anyContentType: true, ...options, accept402: false });
  if (!response.success) return { success: false, error: response.error, transient: isTransientFetchError(response.error) };

  const paths = new Set<string>();
  for (const match of (response.body ?? "").matchAll(/https:\/\/[^\s"'<>\\]+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === domain && url.pathname !== "/" && !url.pathname.startsWith("/.well-known/")) paths.add(url.pathname);
    } catch { /* not a URL */ }
    if (paths.size === 3) break;
  }
  if (!paths.size) return { success: false, error: "no_listed_resource" };
  let transient = false;
  for (const path of paths) {
    let answer = await fetchPublicJson(domain, path, options);
    // Many paid endpoints take POST only; ask the way an x402 client's unpaid first request does.
    if (answer.error === "HTTP 405") answer = await fetchPublicJson(domain, path, { ...options, emptyPost: true });
    if (isX402Challenge(answer)) return { success: true };
    transient ||= isTransientFetchError(answer.error);
  }
  return { success: false, error: "no_x402_challenge", transient };
}
