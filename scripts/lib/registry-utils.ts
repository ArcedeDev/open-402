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
  const seen = new Set<string>();
  return content
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, index }) => {
      const parts = line.split("|").map((p) => p.trim());
      const [domain, status, source, date] = parts;
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? new Date(`${date}T00:00:00Z`) : null;
      if (parts.length !== 4 || !domain || /[\s/:@?#]/.test(domain)
        || !["verified", "unclaimed"].includes(status) || !/^[a-z0-9-]+$/.test(source ?? "")
        || !parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
        throw new Error(`Invalid registry row at line ${index + 1}`);
      }
      if (seen.has(domain.toLowerCase())) throw new Error(`Duplicate registry domain at line ${index + 1}`);
      seen.add(domain.toLowerCase());
      return {
        domain,
        status: status as "verified" | "unclaimed",
        source,
        added_date: date,
      };
    });
}

export function formatDomainLine(entry: DomainEntry): string {
  const fields = [entry.domain, entry.status, entry.source, entry.added_date];
  if (fields.some((field) => typeof field !== "string" || /[|\r\n]/.test(field))) throw new Error("Registry fields cannot contain delimiters");
  const line = fields.join(" | ");
  parseDomainsTxt(line);
  return line;
}

export function registryChanges(previous: DomainEntry[], current: DomainEntry[]) {
  const previousByDomain = new Map(previous.map((entry) => [entry.domain, entry]));
  const currentDomains = new Set(current.map((entry) => entry.domain));
  const changed = current.filter((entry) => JSON.stringify(entry) !== JSON.stringify(previousByDomain.get(entry.domain)));
  const removed = previous.filter((entry) => !currentDomains.has(entry.domain));
  if (changed.length + removed.length > 100) throw new Error("Bulk listing changes require a separate maintainer review");
  return { changed, removed };
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

  const content = `${finalizedLines.join("\n").trimEnd()}\n`;
  parseDomainsTxt(content);
  return { content, changed: changed || content !== currentContent };
}
