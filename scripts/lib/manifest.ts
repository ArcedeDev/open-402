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
  maxBytes?: number;
  request?: typeof request;
  lookup?: typeof lookup;
}

export async function crawlDomain(domain: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  if (!isPublicDomain(domain)) return { success: false, error: "blocked" };
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
        if (status !== 200 || !String(res.headers["content-type"] ?? "").toLowerCase().includes("json")) {
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
    const url = new URL(`https://${domain}/.well-known/agent.json`);
    let response = await read(url);
    if (response.location) response = await read(new URL(response.location, url));
    if (response.location) return { success: false, error: "too_many_redirects" };
    let value: unknown;
    try { value = JSON.parse(response.body ?? ""); }
    catch { return { success: false, error: "invalid_json" }; }
    return validateManifest(value, domain);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request_failed";
    const known = /^(blocked|blocked_address|too_large|body_aborted|redirect_no_location|not_json|unsupported_encoding|HTTP \d+)$/;
    return { success: false, error: controller.signal.aborted ? "timeout" : known.test(message) ? message : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}
