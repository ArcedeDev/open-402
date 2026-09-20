import assert from "node:assert/strict";
import test from "node:test";
import { fixture, runPreflight } from "./protection-preflight.mjs";

const sha = "a".repeat(40);
const env = { PREFLIGHT_APPROVED: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "ArcedeDev/open-402", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, REVIEWED_SHA: sha, FIXTURE_KEY: "0".repeat(16), PUBLISHER_TOKEN: "publisher-sentinel", ORDINARY_TOKEN: "ordinary-sentinel" };
const config = {
  enforce_admins: { enabled: false },
  required_status_checks: { strict: true, checks: [{ context: "Registry checks", app_id: 15368 }] },
  required_pull_request_reviews: {
    required_approving_review_count: 0, dismiss_stale_reviews: true,
    require_code_owner_reviews: false, require_last_push_approval: false,
    bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
  },
  restrictions: null, required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
};
const integrity = {
  target: "branch",
  enforcement: "active",
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
};

function simulation(options = {}) {
  const { base, topic, rulesetName } = fixture(env);
  const refs = new Map([[base, sha], ["main", sha]]);
  const commits = new Map([[sha, { tree: { sha: "original-tree" } }]]);
  const trees = new Map();
  const logs = [];
  const calls = [];
  let serial = 0;
  let currentConclusion;
  let protectionReads = 0;
  let prCreated = false;
  let prBase = base;
  let observedRetarget = false;
  const response = (status, data) => ({ status, json: async () => data });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace("/repos/ArcedeDev/open-402", "");
    const body = init.body && JSON.parse(init.body);
    const publisher = init.headers.Authorization === `Bearer ${env.PUBLISHER_TOKEN}`;
    calls.push({ path, method: init.method, body, publisher });
    if (prCreated && options.retargetBeforeCall === calls.length) prBase = "main";
    const ok = (data, status = 200) => response(status, data);
    if (path === "/user") return ok({ login: "fixture-owner", id: 1, type: "User" });
    if (path === "") return ok({ permissions: { admin: publisher ? options.publisherAdmin !== false : false, push: publisher || options.ordinaryAclPush !== false } });
    if (path.startsWith("/git/ref/heads/")) {
      const value = refs.get(path.slice("/git/ref/heads/".length));
      return value ? ok({ object: { sha: value } }) : response(404, {});
    }
    if (path.endsWith("/protection")) {
      protectionReads++;
      if (protectionReads > 1 && options.removeProtection) return response(404, {});
      if (protectionReads > 1 && options.finalDeniedRead === "classic") return response(403, {});
      const settings = structuredClone(config);
      if (options.contexts !== undefined) settings.required_status_checks.contexts = options.contexts;
      if (protectionReads > 1 && options.changeCheckApp) settings.required_status_checks.checks[0].app_id = 99;
      if (protectionReads > 1 && options.changeClassic) settings.required_pull_request_reviews.dismiss_stale_reviews = false;
      if (protectionReads > 1 && options.addPrBypass) settings.required_pull_request_reviews.bypass_pull_request_allowances.users.push({ login: "unexpected" });
      return ok(settings);
    }
    const ruleId = protectionReads > 1 && options.replaceRuleset ? 19 : 9;
    if (path.startsWith("/rules/branches/")) {
      if (protectionReads > 1 && options.finalDeniedRead === "effective") return response(403, {});
      return ok(protectionReads > 1 && options.removeRules ? [] : integrity.rules.map((rule) => ({ ...rule, ruleset_id: ruleId })));
    }
    if (path === `/rulesets/${ruleId}`) {
      if (protectionReads > 1 && options.finalDeniedRead === "ruleset") return response(403, {});
      return ok({ ...integrity, id: ruleId, name: rulesetName, enforcement: protectionReads > 1 && options.disableRuleset ? "disabled" : "active", bypass_actors: options.bypass || (protectionReads > 1 && options.addFinalBypass) ? [{ actor_type: "OrganizationAdmin" }] : [], conditions: { ref_name: { include: [`refs/heads/${base}`], exclude: [] } } });
    }
    if (path.startsWith("/git/commits/")) return ok(commits.get(path.split("/").at(-1)));
    if (path === "/git/commits") {
      const next = (++serial).toString(16).padStart(40, "0");
      commits.set(next, { tree: { sha: body.tree } });
      return ok({ sha: next }, 201);
    }
    if (path === "/git/trees") {
      const next = `tree-${++serial}`;
      trees.set(next, body.tree.some((entry) => entry.path === "registry/domains.txt") ? "failure" : "success");
      return ok({ sha: next }, 201);
    }
    if (path === "/git/refs") { refs.set(body.ref.replace("refs/heads/", ""), body.sha); return ok({}, 201); }
    if (path.startsWith("/git/refs/heads/")) {
      const branch = path.slice("/git/refs/heads/".length);
      if (init.method === "DELETE") return response(422, { message: "Repository rule violations found: cannot delete" });
      if (branch === base && !publisher) return response(403, { message: "Protected branch: pull request required" });
      if (body.force && !options.allowForce) return response(422, { message: options.ambiguousForce ? "Protected branch" : "Repository rule violations found: cannot force-push" });
      if (branch === topic && !publisher && options.denyWriteControl) return response(403, { message: "Resource not accessible by integration" });
      refs.set(branch, body.sha);
      return ok({});
    }
    if (path === "/pulls") { prCreated = true; return ok({ number: 47 }, 201); }
    if (path === "/actions/workflows/registry-checks.yml/runs") {
      const requested = u.searchParams.get("head_sha");
      currentConclusion = trees.get(commits.get(requested).tree.sha);
      return ok({ workflow_runs: [{ id: 10, head_sha: options.wrongHead ? sha : requested, event: "pull_request", status: "completed", conclusion: currentConclusion, pull_requests: [{ number: 47 }] }] });
    }
    if (path === "/actions/runs/10/jobs") return ok({ jobs: [{ name: "Registry checks", conclusion: currentConclusion, check_run_url: "https://api.github.com/repos/ArcedeDev/open-402/check-runs/11" }] });
    if (path === "/check-runs/11") return ok({ name: "Registry checks", status: "completed", conclusion: currentConclusion, app: { id: options.wrongApp ? 99 : 15368 } });
    if (path === "/pulls/47") {
      if (prBase !== base) observedRetarget = true;
      return ok({ base: { ref: prBase, repo: { full_name: "ArcedeDev/open-402" } }, head: { ref: topic, sha: refs.get(topic), repo: { full_name: "ArcedeDev/open-402" } }, state: "open", mergeable: true, mergeable_state: options.wrongPrState ? "unknown" : currentConclusion === "failure" ? "blocked" : "clean" });
    }
    // An unsafe future merge would succeed against the mutable PR target.
    if (path === "/pulls/47/merge") {
      refs.set(prBase, "b".repeat(40));
      return ok({ merged: true, sha: refs.get(prBase) });
    }
    throw new Error(`Unexpected fixture request: ${init.method} ${path}`);
  };
  return { calls, logs, refs, get observedRetarget() { return observedRetarget; }, deps: { fetchImpl, sleep: async () => {}, log: (line) => logs.push(JSON.parse(line)) } };
}

test("closed gate, wrong repository/ref/SHA and unsafe fixture names make zero requests", async () => {
  for (const patch of [{ PREFLIGHT_APPROVED: "false" }, { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_REF: "refs/heads/topic" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_SHA: "b".repeat(40) }, { FIXTURE_KEY: "main" }, { FIXTURE_KEY: "../main" }]) {
    let requests = 0;
    await assert.rejects(runPreflight({ ...env, ...patch }, { fetchImpl: async () => { requests++; throw new Error("Must not request"); } }));
    assert.equal(requests, 0);
  }
});

test("matrix observes exact-head PR states without merging and revalidates canonical protection before PASS", async () => {
  const sim = simulation();
  await runPreflight(env, sim.deps);
  const receipt = sim.logs.at(-1);
  assert.equal(receipt.event, "PASS");
  assert.equal(receipt.pr_state_only, true);
  assert.equal(receipt.ruleset_id, 9);
  assert.equal(receipt.merged_sha, undefined);
  assert.match(receipt.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(receipt.configuration, sim.logs.find((entry) => entry.event === "configuration_verified").configuration);
  assert.equal(sim.calls.filter((call) => call.path.endsWith("/protection")).length, 2);
  assert.deepEqual(sim.calls.slice(-3).map((call) => call.path), [`/branches/${fixture(env).base}/protection`, `/rules/branches/${fixture(env).base}`, "/rulesets/9"]);
  assert.deepEqual(sim.logs.filter((entry) => entry.event === "pr_state_observed").map((entry) => entry.mergeable_state), ["blocked", "clean"]);
  assert.equal(sim.logs.filter((entry) => entry.event === "registry_check").at(-1).sha, receipt.checked_head_sha);
  assert.ok(sim.calls.every((call) => !call.path.endsWith("/merge") && call.method !== "PUT"));
  assert.ok(sim.logs.some((entry) => entry.event === "ordinary_write_control_passed"));
  assert.ok(sim.calls.filter((call) => call.method !== "GET").every((call) => !call.path.includes("heads/main") && call.body?.base !== "main" && call.body?.ref !== "refs/heads/main"));
  const output = JSON.stringify(sim.logs);
  assert.ok(!output.includes(env.PUBLISHER_TOKEN) && !output.includes(env.ORDINARY_TOKEN));
});

test("protection readback accepts absent, empty or derived contexts but not unrelated contexts", async () => {
  for (const contexts of [undefined, [], ["Registry checks"]]) {
    const sim = simulation({ contexts });
    await runPreflight(env, sim.deps);
    assert.equal(sim.logs.at(-1).event, "PASS");
  }
  const invalid = simulation({ contexts: ["Unrelated check"] });
  await assert.rejects(runPreflight(env, invalid.deps));
  assert.ok(invalid.calls.every((call) => call.method === "GET"));
});

test("ordinary ACL push=false can PASS only with actual authorized topic writes", async () => {
  const sim = simulation({ ordinaryAclPush: false });
  await runPreflight(env, sim.deps);
  assert.equal(sim.logs.find((entry) => entry.event === "identity").ordinary.push, false);
  assert.ok(sim.calls.some((call) => call.path === "/git/refs" && call.method === "POST" && !call.publisher));
  assert.ok(sim.calls.some((call) => call.path === `/git/refs/heads/${fixture(env).topic}` && call.method === "PATCH" && !call.publisher));
  assert.ok(sim.logs.some((entry) => entry.event === "ordinary_write_control_passed"));
  assert.equal(sim.logs.at(-1).event, "PASS");
});

test("ordinary ACL push=false and actual topic update 403 withholds PASS", async () => {
  const sim = simulation({ ordinaryAclPush: false, denyWriteControl: true });
  await assert.rejects(runPreflight(env, sim.deps), /ordinary PATCH HTTP 403/);
  assert.ok(sim.calls.some((call) => call.path === `/git/refs/heads/${fixture(env).topic}` && call.method === "PATCH" && !call.publisher));
  assert.ok(!sim.logs.some((entry) => ["PASS", "ordinary_write_control_passed"].includes(entry.event)));
});

test("unexpected HTTP diagnostics reveal only fixed metadata and never read the body", async () => {
  const root = "/repos/ArcedeDev/open-402";
  const { base } = fixture(env);
  for (const [target, route] of [["/user", "/user"], ["", root],
    [`/git/ref/heads/${base}`, `${root}/git/ref/{fixture}`],
    [`/branches/${base}/protection`, `${root}/branches/{fixture}/protection`],
    [`/rules/branches/${base}`, `${root}/rules/branches/{fixture}`],
    ["/rulesets/9", `${root}/rulesets/{id}`]]) {
    const sim = simulation();
    let bodyReads = 0;
    const secret = [env.PUBLISHER_TOKEN, env.ORDINARY_TOKEN, "private-response-marker"].join(":");
    const fetchImpl = async (url, init) => {
      const path = decodeURIComponent(new URL(url).pathname).replace(root, "");
      if (path !== target) return sim.deps.fetchImpl(url, init);
      return { status: 403, headers: { private: secret }, json: async () => { bodyReads++; throw new Error(secret); } };
    };
    await assert.rejects(runPreflight(env, { ...sim.deps, fetchImpl }));
    assert.equal(bodyReads, 0);
    const diagnostic = sim.logs.find((entry) => entry.event === "http_unexpected_status");
    assert.deepEqual(diagnostic, { event: "http_unexpected_status", actor: target.startsWith("/git/ref/") ? "ordinary" : "publisher", method: "GET", route, status: 403 });
    assert.ok(!sim.logs.some((entry) => entry.event === "PASS"));
    const output = JSON.stringify(sim.logs);
    for (const value of [env.PUBLISHER_TOKEN, env.ORDINARY_TOKEN, "private-response-marker"]) assert.ok(!output.includes(value));
  }
});

test("safe stages identify initial reads and both configuration validation passes", async () => {
  const sim = simulation();
  await runPreflight(env, sim.deps);
  assert.deepEqual(sim.logs.filter((entry) => entry.event === "stage"), [
    { event: "stage", name: "identity" }, { event: "stage", name: "start_ref" }, { event: "stage", name: "topic_absence" },
    ...["initial", "final"].flatMap((phase) => ["config_classic", "config_effective_rules", "config_ruleset"].map((name) => ({ event: "stage", name, phase }))),
    { event: "stage", name: "config_compare" },
  ]);
});

test("retarget fuzz at every request boundary cannot merge; observed retargets withhold PASS", async () => {
  const baseline = simulation();
  await runPreflight(env, baseline.deps);
  const creation = baseline.calls.findIndex((call) => call.path === "/pulls" && call.method === "POST");
  let observed = 0;
  let afterLastObservation = 0;
  for (let boundary = creation + 2; boundary <= baseline.calls.length; boundary++) {
    const sim = simulation({ retargetBeforeCall: boundary });
    let failed = false;
    try { await runPreflight(env, sim.deps); } catch { failed = true; }
    assert.ok(sim.calls.every((call) => !call.path.endsWith("/merge") && call.method !== "PUT"));
    assert.equal(sim.refs.get("main"), sha);
    if (sim.observedRetarget) {
      observed++;
      assert.equal(failed, true);
      assert.ok(!sim.logs.some((entry) => entry.event === "PASS"));
    } else {
      afterLastObservation++;
    }
  }
  assert.ok(observed > 0 && afterLastObservation > 0);
});

for (const [label, options] of Object.entries({ "non-admin publisher": { publisherAdmin: false }, "integrity bypass": { bypass: true }, "force push unexpectedly accepted": { allowForce: true }, "ambiguous integrity denial": { ambiguousForce: true }, "missing ordinary write scope": { denyWriteControl: true }, "wrong check app": { wrongApp: true }, "CI on another head": { wrongHead: true }, "unsettled PR state": { wrongPrState: true }, "removed classic protection": { removeProtection: true }, "removed effective rules": { removeRules: true }, "changed check app": { changeCheckApp: true }, "changed classic settings": { changeClassic: true }, "new PR bypass": { addPrBypass: true }, "new integrity bypass": { addFinalBypass: true }, "replacement ruleset ID": { replaceRuleset: true }, "disabled ruleset": { disableRuleset: true }, "denied final classic read": { finalDeniedRead: "classic" }, "denied final effective rules read": { finalDeniedRead: "effective" }, "denied final ruleset read": { finalDeniedRead: "ruleset" } })) {
  test(`${label} cannot report PASS`, async () => {
    const sim = simulation(options);
    await assert.rejects(runPreflight(env, sim.deps));
    assert.ok(!sim.logs.some((entry) => entry.event === "PASS"));
  });
}
