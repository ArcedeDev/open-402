export type ManifestHealthError = "timeout" | "unreachable" | "not_found" | "rate_limited"
  | "http_error" | "invalid_manifest" | "invalid_response" | "blocked" | "unknown";

export interface ManifestHealth {
  status: "healthy" | "stale" | "unavailable" | "unknown";
  checked_at: string | null;
  last_success_at: string | null;
  failure_since: string | null;
  failure_days: number;
  error: ManifestHealthError | null;
  demoted_at: string | null;
}

export interface ManifestDemotionBudget {
  date: string;
  used: number;
}

const ERROR_CATEGORIES = new Set<ManifestHealthError>([
  "timeout", "unreachable", "not_found", "rate_limited", "http_error",
  "invalid_manifest", "invalid_response", "blocked", "unknown",
]);

export function categorizeManifestError(error: unknown): ManifestHealthError {
  if (ERROR_CATEGORIES.has(error as ManifestHealthError)) return error as ManifestHealthError;
  if (error === "HTTP 404" || error === "HTTP 410") return "not_found";
  if (error === "HTTP 429") return "rate_limited";
  if (typeof error === "string" && /^HTTP \d{3}$/.test(error)) return "http_error";
  if (error === "origin_mismatch" || error === "invalid_payment_networks") return "invalid_manifest";
  if (error === "blocked_address") return "blocked";
  if (error === "request_failed" || error === "body_aborted") return "unreachable";
  if (typeof error === "string" && ["not_json", "invalid_json", "too_large", "unsupported_encoding", "too_many_redirects", "redirect_no_location"].includes(error)) return "invalid_response";
  return "unknown";
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
  return new Date(time).toISOString() === canonical ? canonical : null;
}

function utcDay(value: string): number {
  return Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`) / 86_400_000;
}

export function normalizeManifestDemotionBudget(value: unknown, now = new Date()): ManifestDemotionBudget {
  const today = now.toISOString().slice(0, 10);
  if (value === undefined) return { date: today, used: 0 };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid manifest demotion budget");
  const budget = value as Record<string, unknown>;
  if (typeof budget.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(budget.date)
    || !timestamp(`${budget.date}T00:00:00.000Z`) || budget.date > today
    || !Number.isSafeInteger(budget.used) || (budget.used as number) < 0) {
    throw new Error("Invalid or future manifest demotion budget");
  }
  return { date: today, used: budget.date === today ? budget.used as number : 0 };
}

export function normalizeManifestHealth(value: unknown, now = new Date()): ManifestHealth {
  const current = now.toISOString();
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const past = (input: unknown) => {
    const parsed = timestamp(input);
    return parsed && parsed <= current ? parsed : null;
  };
  const checked = past(raw.checked_at);
  const success = past(raw.last_success_at);
  const since = past(raw.failure_since);
  const health: ManifestHealth = {
    status: "unknown", checked_at: checked,
    last_success_at: success,
    failure_since: null, failure_days: 0, error: null, demoted_at: past(raw.demoted_at),
  };
  if (raw.status === "healthy" && checked && success === checked
    && raw.failure_since === null && raw.failure_days === 0 && raw.error === null) {
    return { ...health, status: "healthy" };
  }
  if ((raw.status === "stale" || raw.status === "unavailable") && checked && since && since <= checked
    && (raw.last_success_at === null || (success !== null && success <= since)) && Number.isSafeInteger(raw.failure_days)
    && (raw.failure_days as number) >= 1 && (raw.failure_days as number) <= utcDay(checked) - utcDay(since) + 1) {
    return {
      ...health, status: raw.status, failure_since: since,
      failure_days: raw.failure_days as number, error: categorizeManifestError(raw.error),
    };
  }
  return health;
}

export function observeManifestHealth(
  previous: unknown,
  listingStatus: "verified" | "unclaimed",
  outcome: { success: boolean; error?: string },
  now = new Date(),
): ManifestHealth {
  const prior = normalizeManifestHealth(previous, now);
  const checked = now.toISOString();
  if (outcome.success) {
    return {
      status: "healthy", checked_at: checked, last_success_at: checked,
      failure_since: null, failure_days: 0, error: null, demoted_at: prior.demoted_at,
    };
  }
  const continuing = prior.failure_since !== null && prior.checked_at !== null;
  return {
    status: listingStatus === "verified" || prior.last_success_at !== null ? "stale" : "unavailable",
    checked_at: checked,
    last_success_at: prior.last_success_at,
    failure_since: continuing ? prior.failure_since : checked,
    failure_days: continuing
      ? prior.failure_days + (utcDay(checked) > utcDay(prior.checked_at!) ? 1 : 0)
      : 1,
    error: categorizeManifestError(outcome.error),
    demoted_at: prior.demoted_at,
  };
}

interface HealthEntry {
  domain: string;
  status: "verified" | "unclaimed";
  manifest_health?: ManifestHealth;
}

export function applyDailyDemotions<T extends HealthEntry>(
  entries: T[],
  previous: Iterable<HealthEntry>,
  { now = new Date(), thresholdDays = 30, previousBudget }: { now?: Date; thresholdDays?: number; previousBudget?: unknown } = {},
): { entries: T[]; demoted: number; held: number; dailyLimit: number; alreadyDemotedToday: number; budget: ManifestDemotionBudget } {
  if (!Number.isSafeInteger(thresholdDays) || thresholdDays < 1) throw new Error("Invalid demotion threshold");
  const checked = now.toISOString();
  const today = checked.slice(0, 10);
  const persistedBudget = normalizeManifestDemotionBudget(previousBudget, now);
  const dailyLimit = Math.min(25, Math.floor(entries.length * 0.01));
  const used = new Set<string>();
  // Count persisted demotions even when a listing recovered or was removed this run.
  for (const entry of [...previous, ...entries]) {
    if (timestamp(entry.manifest_health?.demoted_at)?.slice(0, 10) === today) used.add(entry.domain);
  }
  const alreadyDemotedToday = Math.max(persistedBudget.used, used.size);
  const candidates = entries.flatMap((entry) => {
    const health = normalizeManifestHealth(entry.manifest_health, now);
    return entry.status === "verified" && (health.status === "stale" || health.status === "unavailable")
      && health.failure_days >= thresholdDays && !used.has(entry.domain)
      ? [{ entry, health }] : [];
  }).sort((a, b) => {
    const left = a.health.failure_since!;
    const right = b.health.failure_since!;
    return left < right ? -1 : left > right ? 1
      : a.entry.domain < b.entry.domain ? -1 : a.entry.domain > b.entry.domain ? 1 : 0;
  });
  const selected = new Map(candidates.slice(0, Math.max(0, dailyLimit - alreadyDemotedToday))
    .map(({ entry, health }) => [entry.domain, { ...health, demoted_at: checked }]));
  return {
    entries: entries.map((entry) => selected.has(entry.domain)
      ? { ...entry, status: "unclaimed", manifest_health: selected.get(entry.domain)! } : entry),
    demoted: selected.size,
    held: candidates.length - selected.size,
    dailyLimit,
    alreadyDemotedToday,
    budget: { date: today, used: alreadyDemotedToday + selected.size },
  };
}
