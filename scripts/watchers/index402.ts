/**
 * 402index.io Multi-Protocol Watcher
 *
 * Pulls ALL protocols (L402, MPP) from 402index.io that aren't already
 * covered by the x402 watcher. This gives us Lightning and fiat payment
 * APIs without needing separate L402/MPP watcher implementations.
 *
 * 402index.io aggregates from: Satring, L402 Apps, Sponge, MPP/Tempo,
 * x402 Bazaar, and self-registered services.
 *
 * API docs: https://402index.io/api/v1/docs.md
 * OpenAPI spec: https://402index.io/api/v1/openapi.json
 */

import type { PaymentEvent, PaymentRailWatcher } from "./types";
import { extractDomain } from "./utils";

function log(msg: string): void {
  console.log(`[402index] ${msg}`);
}

export class Index402Watcher implements PaymentRailWatcher {
  protocol = "402index"; // meta-protocol — aggregates L402, MPP, etc.

  async fetchEvents(lastCheckpoint: string): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];

    // Pull L402 (Lightning) services
    const l402 = await this.fetchByProtocol("L402");
    events.push(...l402);
    log(`L402 services: ${l402.length}`);

    // Pull MPP (Machine Payments Protocol / fiat) services
    const mpp = await this.fetchByProtocol("MPP");
    events.push(...mpp);
    log(`MPP services: ${mpp.length}`);

    // Deduplicate by domain
    const seen = new Map<string, PaymentEvent>();
    for (const event of events) {
      if (event.domain && !seen.has(event.domain)) {
        seen.set(event.domain, event);
      }
    }

    log(`Total: ${seen.size} unique domains (L402 + MPP)`);
    return Array.from(seen.values());
  }

  private async fetchByProtocol(protocol: string): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];

    try {
      let offset = 0;
      const pageSize = 500;

      // Paginate through all results
      while (true) {
        const url = `https://402index.io/api/v1/services?protocol=${protocol}&limit=${pageSize}&offset=${offset}`;
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "Open402DirectoryWatcher/1.0",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          log(`${protocol}: 402index.io responded ${res.status}`);
          break;
        }

        const data = await res.json();
        const services = Array.isArray(data) ? data : data.services || data.data || [];

        if (services.length === 0) break; // No more results

        for (const svc of services) {
          const svcUrl = svc.url || svc.endpoint || svc.baseUrl || "";
          const domain = extractDomain(svcUrl);
          if (!domain) continue;

          events.push({
            protocol: (svc.protocol || protocol).toLowerCase(),
            resourceUrl: svcUrl,
            domain,
            sellerAddress: svc.payTo || svc.seller || svc.paymentAddress || "",
            amount: String(svc.price || svc.minPrice || "0"),
            asset: svc.asset || svc.paymentAsset || (protocol === "L402" ? "BTC" : "USD"),
            network: svc.network || svc.chain || (protocol === "L402" ? "lightning" : "stripe"),
            txHash: undefined,
            timestamp: svc.lastSeen || svc.updatedAt || svc.createdAt || new Date().toISOString(),
          });
        }

        offset += pageSize;
        if (services.length < pageSize) break; // Last page
      }
    } catch (e) {
      log(`${protocol} fetch failed: ${e instanceof Error ? e.message : e}`);
    }

    return events;
  }
}
