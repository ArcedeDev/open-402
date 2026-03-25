/**
 * x402 On-Chain Watcher — Phase 2
 *
 * Discovers domains accepting x402 payments by pulling from two public APIs:
 *
 *   1. x402scan.com — tRPC API listing ~1,900+ x402-accepting origins
 *      Endpoint: /api/trpc/public.origins.list.origins
 *
 *   2. 402index.io — REST API aggregating x402, L402, MPP services
 *      Endpoint: /api/v1/services?protocol=x402
 *
 * Both are fully public, no auth required. The watcher deduplicates by domain
 * and feeds newly discovered domains into the registry.
 *
 * This replaces the previous approach of querying raw EVM Transfer events,
 * which couldn't discover domains (only wallet addresses).
 */

import type { PaymentEvent, PaymentRailWatcher } from "./types";
import { extractDomain } from "./utils";
import { getNextOffset, parsePaginatedServicesResponse } from "./pagination.ts";

function log(msg: string): void {
  console.log(`[x402] ${msg}`);
}

export class X402Watcher implements PaymentRailWatcher {
  protocol = "x402";

  async fetchEvents(lastCheckpoint: string): Promise<PaymentEvent[]> {
    const domainMap = new Map<string, PaymentEvent>(); // dedupe by domain

    // Source 1: x402scan.com (primary — largest x402-specific dataset)
    const scanResults = await this.fetchFromX402Scan();
    for (const event of scanResults) {
      if (event.domain && !domainMap.has(event.domain)) {
        domainMap.set(event.domain, event);
      }
    }
    log(`x402scan.com: ${scanResults.length} origins → ${domainMap.size} unique domains`);

    // Source 2: 402index.io (secondary — multi-protocol aggregator)
    const indexResults = await this.fetchFrom402Index();
    let newFromIndex = 0;
    for (const event of indexResults) {
      if (event.domain && !domainMap.has(event.domain)) {
        domainMap.set(event.domain, event);
        newFromIndex++;
      }
    }
    log(`402index.io: ${indexResults.length} services → ${newFromIndex} new unique domains`);

    log(`Total: ${domainMap.size} unique domains discovered`);
    return Array.from(domainMap.values());
  }

  /**
   * x402scan.com — tRPC public API
   *
   * Returns all known x402-accepting origins with server URL, title,
   * description, and timestamps. ~1,900+ entries as of March 2026.
   */
  private async fetchFromX402Scan(): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];

    try {
      const input = encodeURIComponent(JSON.stringify({ "0": { json: {} } }));
      const url = `https://x402scan.com/api/trpc/public.origins.list.origins?batch=1&input=${input}`;

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Open402DirectoryWatcher/1.0",
        },
        signal: AbortSignal.timeout(30_000), // 30s — large response
      });

      if (!res.ok) {
        log(`x402scan.com responded ${res.status}`);
        return events;
      }

      const data = await res.json();

      // tRPC batch response: [{ result: { data: { json: [...] } } }]
      const origins = data?.[0]?.result?.data?.json || data?.[0]?.result?.data || [];

      if (!Array.isArray(origins)) {
        log(`x402scan.com: unexpected response shape`);
        return events;
      }

      for (const origin of origins) {
        const serverUrl = origin.url || origin.serverUrl || origin.origin || "";
        const domain = extractDomain(serverUrl);
        if (!domain) continue;

        events.push({
          protocol: "x402",
          resourceUrl: serverUrl,
          domain,
          sellerAddress: origin.payTo || origin.seller || "",
          amount: "0",
          asset: "USDC",
          network: "base",
          txHash: undefined,
          timestamp: origin.updatedAt || origin.createdAt || new Date().toISOString(),
        });
      }
    } catch (e) {
      log(`x402scan.com fetch failed: ${e instanceof Error ? e.message : e}`);
    }

    return events;
  }

  /**
   * 402index.io — REST API
   *
   * Aggregates services from multiple sources: x402 Bazaar, Satring,
   * L402 Apps, Sponge, MPP/Tempo. We filter for x402 protocol specifically
   * but could expand to pull all protocols.
   *
   * Free tier: 100 req/min. We make 1-2 requests per nightly run.
   */
  private async fetchFrom402Index(): Promise<PaymentEvent[]> {
    const events: PaymentEvent[] = [];

    try {
      let offset = 0;
      const requestedPageSize = 500;
      const maxTotal = 20_000;
      let announcedTotal: number | null = null;

      while (offset < maxTotal) {
        const page = await this.fetch402IndexPage(offset, requestedPageSize);
        if (!page) break;

        if (announcedTotal == null && page.total != null) {
          announcedTotal = page.total;
          log(`402index.io has ${page.total} total x402 services, paginating (capped at ${Math.min(page.total, maxTotal)})...`);
        }

        for (const svc of page.items) {
          const svcUrl = svc.url || svc.endpoint || svc.baseUrl || "";
          const domain = extractDomain(String(svcUrl));
          if (!domain) continue;

          events.push({
            protocol: String(svc.protocol || "x402"),
            resourceUrl: String(svcUrl),
            domain,
            sellerAddress: String(svc.payTo || svc.seller || svc.paymentAddress || ""),
            amount: String(svc.price || svc.minPrice || "0"),
            asset: String(svc.asset || svc.paymentAsset || "USDC"),
            network: String(svc.network || svc.chain || "base"),
            txHash: undefined,
            timestamp: String(svc.lastSeen || svc.updatedAt || svc.createdAt || new Date().toISOString()),
          });
        }

        const nextOffset = getNextOffset(page);
        if (nextOffset == null || nextOffset <= offset) break;
        offset = nextOffset;
      }
    } catch (e) {
      log(`402index.io fetch failed: ${e instanceof Error ? e.message : e}`);
    }

    return events;
  }

  private async fetch402IndexPage(
    offset: number,
    requestedPageSize: number
  ): Promise<ReturnType<typeof parsePaginatedServicesResponse<Record<string, unknown>>> | null> {
    try {
      const url = `https://402index.io/api/v1/services?protocol=x402&limit=${requestedPageSize}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Open402DirectoryWatcher/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;

      const data = await res.json();
      return parsePaginatedServicesResponse<Record<string, unknown>>(data, offset);
    } catch (e) {
      log(`402index.io page fetch failed: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}
