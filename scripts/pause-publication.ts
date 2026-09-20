import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repo = "ArcedeDev/open-402";
const workflow = "nightly-crawl.yml";
type Gh = (args: string[]) => string;

export async function pausePublication(
  gh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8" }),
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  gh(["workflow", "disable", workflow, "--repo", repo]);
  for (let attempt = 0; attempt < 60; attempt++) {
    const output = gh(["api", "--paginate", `repos/${repo}/actions/workflows/${workflow}/runs`, "--jq", '.workflow_runs[] | select(.status != "completed") | .id']);
    const ids = output.trim() ? output.trim().split(/\s+/) : [];
    if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("Unexpected workflow-run identifier");
    if (!ids.length) return gh(["api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();
    for (const id of ids) {
      try { gh(["run", "cancel", id, "--repo", repo]); }
      catch { /* A run may finish between listing and cancellation; recheck below. */ }
    }
    await wait(3_000);
  }
  throw new Error("Workflow disabled, but publishers are not confirmed stopped; do not restore data yet");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).join(" ") !== "--confirm") throw new Error("Pass --confirm to disable and cancel publication");
  const head = await pausePublication();
  console.log(`Publication paused; all runs terminal. Inspect main at ${head} and downstream sync before recovery. Cancellation does not undo an accepted publication.`);
}
