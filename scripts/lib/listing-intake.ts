/**
 * Pure rules for the listing intake job (scripts/intake-listings.ts).
 *
 * A contributor PR is eligible to land without a maintainer only when its whole change is one
 * registry row: one added line in registry/domains.txt and, for an upgrade, the removal of that
 * same domain's existing row. Everything else goes to a maintainer. The job never checks out or
 * runs contributor code; it reads the PR's file list and patch text from the API.
 */
import { formatDomainLine, parseDomainsTxt, registryChanges, type DomainEntry } from "./registry-utils.ts";
import { isPublicDomain } from "./manifest.ts";

export const REGISTRY_PATH = "registry/domains.txt";
export const CONTRIBUTOR_SOURCES = new Set(["self", "submit"]);

export interface PullRequestFile {
  filename: string;
  status: string;
  patch?: string;
}

/** A row to land, and the row it expects to find on main: null for an addition. */
export interface IntakeRow {
  entry: DomainEntry;
  prior: DomainEntry | null;
}

export type Decision =
  | { kind: "eligible"; row: IntakeRow; mode: "add" | "upgrade" }
  | { kind: "landed"; entry: DomainEntry }
  | { kind: "duplicate"; domain: string; existing: DomainEntry }
  | { kind: "review"; reason: string };

/** Added and removed registry rows in a unified diff, ignoring comment and blank lines. */
export function patchRows(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    const sign = line[0];
    const body = line.slice(1).trim();
    if ((sign !== "+" && sign !== "-") || !body || body.startsWith("#")) continue;
    (sign === "+" ? added : removed).push(body);
  }
  return { added, removed };
}

function parseRow(row: string): DomainEntry | null {
  try {
    const [entry] = parseDomainsTxt(row);
    return entry && formatDomainLine(entry) === row ? entry : null;
  } catch {
    return null;
  }
}

const same = (a: DomainEntry | null | undefined, b: DomainEntry | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const find = (registry: DomainEntry[], domain: string) => registry.find((candidate) => candidate.domain.toLowerCase() === domain.toLowerCase());

/**
 * Classify one PR against the current main registry. `submitted` is the PR's creation date
 * (YYYY-MM-DD, UTC): an added row is dated by it, whatever date the contributor typed. An upgrade
 * keeps main's source and date and changes only the status.
 */
export function classifyPullRequest(files: PullRequestFile[], main: DomainEntry[], submitted: string): Decision {
  if (files.length !== 1 || files[0].filename !== REGISTRY_PATH || files[0].status !== "modified") {
    return { kind: "review", reason: `it changes files other than ${REGISTRY_PATH}` };
  }
  if (typeof files[0].patch !== "string") return { kind: "review", reason: "the patch is too large to read" };
  const { added, removed } = patchRows(files[0].patch);
  if (added.length !== 1) return { kind: "review", reason: "it adds more or fewer than one registry row" };
  if (removed.length > 1) return { kind: "review", reason: "it removes more than one registry row" };

  const proposed = parseRow(added[0]);
  if (!proposed) return { kind: "review", reason: "the added row does not match `domain | status | source | YYYY-MM-DD`" };
  if (proposed.domain !== proposed.domain.toLowerCase() || !isPublicDomain(proposed.domain)) {
    return { kind: "review", reason: "the domain is not a lowercase public domain name" };
  }
  if (!CONTRIBUTOR_SOURCES.has(proposed.source)) return { kind: "review", reason: "the source must be `self` or `submit`" };

  const existing = find(main, proposed.domain);
  if (removed.length === 1) {
    const old = parseRow(removed[0]);
    if (!old || old.domain.toLowerCase() !== proposed.domain) return { kind: "review", reason: "it removes a row for a different domain" };
    if (!existing) return { kind: "review", reason: "the row it replaces is no longer on main" };
  }
  if (existing) {
    // Already verified on main (landed by this job, or by the nightly crawl): nothing left to do.
    if (existing.status === "verified" && proposed.status === "verified") return { kind: "landed", entry: existing };
    if (existing.status === "unclaimed" && proposed.status === "verified") {
      return { kind: "eligible", mode: "upgrade", row: { entry: { ...existing, status: "verified" }, prior: existing } };
    }
    if (removed.length === 1) return { kind: "review", reason: "it changes an existing listing other than upgrading it to verified" };
    // Landed by this job (or submitted twice), as against a different listing of the same domain.
    return existing.status === proposed.status && existing.source === proposed.source
      ? { kind: "landed", entry: existing }
      : { kind: "duplicate", domain: existing.domain, existing };
  }
  return { kind: "eligible", mode: "add", row: { entry: { ...proposed, added_date: submitted }, prior: null } };
}

/**
 * Apply accepted rows to the newest registry text. A row already on main exactly as intended is
 * skipped, so a retried batch is a no-op. Otherwise main must still hold the row each one expects
 * (nothing, for an addition), or the batch is refused. Upgrades replace their row in place,
 * additions go at the end, and `# Total domains` is recounted. The result must parse, and the only
 * changes against `current` must be exactly the rows not skipped, with no removals.
 */
export function applyRows(current: string, rows: IntakeRow[]): string {
  const onMain = parseDomainsTxt(current);
  const domains = new Set(rows.map(({ entry }) => entry.domain.toLowerCase()));
  if (domains.size !== rows.length) throw new Error("Duplicate domain in one intake batch");
  const pending = rows.filter(({ entry, prior }) => {
    const now = find(onMain, entry.domain);
    if (same(now, entry)) return false;
    if (!same(now, prior)) throw new Error(`Main changed under ${entry.domain}; it will be re-checked next run`);
    return true;
  });
  if (!pending.length) return current;

  const byDomain = new Map(pending.map(({ entry }) => [entry.domain.toLowerCase(), entry]));
  const placed = new Set<string>();
  const lines = current.replace(/\n+$/, "").split("\n").map((line) => {
    if (!line.trim() || line.startsWith("#")) return line;
    const domain = line.split("|")[0].trim().toLowerCase();
    const entry = byDomain.get(domain);
    if (!entry) return line;
    placed.add(domain);
    return formatDomainLine(entry);
  });
  for (const [domain, entry] of byDomain) if (!placed.has(domain)) lines.push(formatDomainLine(entry));
  const total = lines.filter((line) => line.trim() && !line.startsWith("#")).length;
  const content = `${lines.map((line) => (line.startsWith("# Total domains:") ? `# Total domains: ${total}` : line)).join("\n")}\n`;

  const { changed, removed } = registryChanges(onMain, parseDomainsTxt(content));
  const expected = new Set(pending.map(({ entry }) => formatDomainLine(entry)));
  if (removed.length || changed.length !== pending.length || changed.some((entry) => !expected.has(formatDomainLine(entry)))) {
    throw new Error("Intake batch changed more than its own rows");
  }
  return content;
}

/** Credit the authenticated PR opener, by GitHub's noreply address; commit metadata is not trusted. */
export function coAuthorTrailer(login: string, id: number): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) || !Number.isSafeInteger(id) || id < 1) return "";
  return `Co-authored-by: ${login} <${id}+${login}@users.noreply.github.com>`;
}
