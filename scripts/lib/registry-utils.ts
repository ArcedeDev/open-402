export interface DomainEntry {
  domain: string;
  status: "verified" | "unclaimed";
  source: string;
  added_date: string;
}

export interface RegistryEntryLike {
  domain: string;
  status: "verified" | "unclaimed";
  intent_count: number;
  source: string;
}

export function parseDomainsTxt(content: string): DomainEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      return {
        domain: parts[0] || "",
        status: (parts[1] === "verified" ? "verified" : "unclaimed") as "verified" | "unclaimed",
        source: parts[2] || "unknown",
        added_date: parts[3] || new Date().toISOString().split("T")[0],
      };
    })
    .filter((entry) => entry.domain);
}

export function formatDomainLine(entry: DomainEntry): string {
  return `${entry.domain} | ${entry.status} | ${entry.source} | ${entry.added_date}`;
}

export function buildUpdatedDomainsTxt(
  currentContent: string,
  entries: RegistryEntryLike[],
  options: { logStatusChanges?: (message: string) => void } = {}
): { content: string; changed: boolean } {
  const domainStatusMap = new Map(entries.map((entry) => [entry.domain, entry.status]));
  const totalEndpoints = entries.reduce((sum, entry) => sum + entry.intent_count, 0);
  const mergedLines: string[] = [];
  let changed = false;

  for (const line of currentContent.split("\n")) {
    if (line.startsWith("#") || !line.trim()) {
      mergedLines.push(line);
      continue;
    }

    const parts = line.split("|").map((part) => part.trim());
    const domain = parts[0];
    const currentStatus = parts[1];
    const newStatus = domainStatusMap.get(domain);

    if (newStatus && newStatus !== currentStatus) {
      const nextLine = formatDomainLine({
        domain,
        status: newStatus,
        source: parts[2] || "unknown",
        added_date: parts[3] || new Date().toISOString().split("T")[0],
      });
      mergedLines.push(nextLine);
      changed = true;
      options.logStatusChanges?.(`STATUS ${domain}: ${currentStatus} → ${newStatus}`);
    } else {
      mergedLines.push(line);
    }
  }

  const existingDomains = new Set(parseDomainsTxt(currentContent).map((entry) => entry.domain));
  const date = new Date().toISOString().split("T")[0];

  for (const entry of entries) {
    if (entry.source.startsWith("onchain-") && !existingDomains.has(entry.domain)) {
      mergedLines.push(
        formatDomainLine({
          domain: entry.domain,
          status: entry.status,
          source: entry.source,
          added_date: date,
        })
      );
      existingDomains.add(entry.domain);
      changed = true;
    }
  }

  const totalDomains = mergedLines.filter((line) => line.trim() && !line.startsWith("#")).length;
  const finalizedLines = mergedLines.map((line) => {
    if (line.startsWith("# Total domains:")) {
      const nextLine = `# Total domains: ${totalDomains}`;
      if (nextLine !== line) changed = true;
      return nextLine;
    }
    if (line.startsWith("# Total endpoints:")) {
      const nextLine = `# Total endpoints: ${totalEndpoints}`;
      if (nextLine !== line) changed = true;
      return nextLine;
    }
    return line;
  });

  return { content: finalizedLines.join("\n"), changed };
}
