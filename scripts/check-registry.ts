import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseDomainsTxt, registryChanges } from "./lib/registry-utils.ts";
import { crawlDomain, isPublicDomain } from "./lib/manifest.ts";
import { mapConcurrent } from "./lib/crawl-runtime.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
if (args.some((arg, i) => arg !== "--live" && arg !== "--base" && !(baseIndex >= 0 && i === baseIndex + 1))) throw new Error("Unknown registry-check argument");
if (baseIndex >= 0 && !/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("--base requires an exact commit SHA");
if (live && !base) throw new Error("Live validation requires --base to bound external requests");

const content = await readFile(new URL("../registry/domains.txt", import.meta.url), "utf8");
const entries = parseDomainsTxt(content);
if (!entries.length) throw new Error("Registry must not be empty");
const previous = base ? parseDomainsTxt(execFileSync("git", ["show", `${base}:registry/domains.txt`], { encoding: "utf8" })) : [];
const { changed, removed } = base ? registryChanges(previous, entries) : { changed: [], removed: [] };
for (const entry of changed) {
  if (!isPublicDomain(entry.domain) || entry.domain !== entry.domain.toLowerCase()) throw new Error(`Invalid public domain: ${entry.domain}`);
}
if (live) await mapConcurrent(changed.filter((entry) => entry.status === "verified"), 5, async (entry) => {
  const result = await crawlDomain(entry.domain);
  if (!result.success) throw new Error(`${entry.domain}: ${result.error}; use unclaimed until a valid manifest is available`);
});
console.log(`Registry valid: ${entries.length} unique rows; ${changed.length} changed listings; ${removed.length} removals${live ? " (verified manifests checked live)" : ""}.`);
