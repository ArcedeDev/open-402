import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const REPO = "ArcedeDev/open-402";
const ROOT = `/repos/${REPO}`;
const CHECK = "Registry checks";
const APP = 15368;

// The tested admin exception also permits ordinary code/workflow writes when
// the credential allows them; only force-push and deletion have no bypass.
export function fixture(env) {
  assert.equal(env.PREFLIGHT_APPROVED, "true", "Reviewed preflight authorization is required");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, REPO);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.FIXTURE_KEY ?? "", /^[a-f0-9]{16}$/);
  assert.match(env.REVIEWED_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_SHA, "Workflow SHA was not reviewed");
  assert.ok(env.PUBLISHER_TOKEN && env.ORDINARY_TOKEN, "Both credentials are required");
  const base = `preflight/open402-${env.FIXTURE_KEY}`;
  return { base, topic: `${base}-pr`, rulesetName: `preflight-integrity-${env.FIXTURE_KEY}` };
}

export async function runPreflight(env, { fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = console.log } = {}) {
  const { base, topic, rulesetName } = fixture(env);
  let prNumber;
  const emit = (event, fields = {}) => log(JSON.stringify({ event, ...fields }));
  const branchPath = (branch) => `${ROOT}/git/refs/${encodeURIComponent(`heads/${branch}`)}`;

  // Limit all mutable API routes and references even if later code is edited.
  function authorize(method, path, body) {
    if (method === "GET") return;
    const refWrite = (method === "PATCH" || method === "DELETE") && [base, topic].some((branch) => path === branchPath(branch));
    const createTopic = method === "POST" && path === `${ROOT}/git/refs` && body?.ref === `refs/heads/${topic}`;
    const objectWrite = method === "POST" && [`${ROOT}/git/trees`, `${ROOT}/git/commits`].includes(path);
    const createPr = method === "POST" && path === `${ROOT}/pulls` && body?.base === base && body?.head === topic;
    assert.ok(refWrite || createTopic || objectWrite || createPr, "Mutation outside disposable fixture refused");
  }
  async function api(actor, method, path, body, expected = [200]) {
    authorize(method, path, body);
    assert.ok(path === "/user" || path.startsWith(`${ROOT}/`) || path === ROOT);
    const token = actor === "publisher" ? env.PUBLISHER_TOKEN : env.ORDINARY_TOKEN;
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? null : await response.json();
    assert.ok(expected.includes(response.status), `${actor} ${method} HTTP ${response.status}; response body withheld`);
    return { status: response.status, data };
  }
  const get = async (actor, path) => (await api(actor, "GET", path)).data;
  const head = async (branch) => (await get("ordinary", `${ROOT}/git/ref/${encodeURIComponent(`heads/${branch}`)}`)).object.sha;
  const update = (actor, branch, sha, force = false, expected = [200]) => api(actor, "PATCH", branchPath(branch), { sha, force }, expected);
  async function commit(parent, tree, message) {
    return (await api("publisher", "POST", `${ROOT}/git/commits`, { message, tree, parents: [parent] }, [201])).data.sha;
  }
  async function denied(label, request, expectedHead, mustBeRuleset = false) {
    const result = await request;
    const message = typeof result.data?.message === "string" ? result.data.message : "";
    assert.match(message, mustBeRuleset ? /repository rule|ruleset|GH013/i : /protected|rule|pull request|required|status check|not mergeable/i, `${label}: denial did not identify protection`);
    assert.equal(await head(base), expectedHead, `${label}: protected ref changed`);
    emit(label, { status: result.status, unchanged: true });
  }

  const principal = await get("publisher", "/user");
  const publisherRepo = await get("publisher", ROOT);
  const ordinaryRepo = await get("ordinary", ROOT);
  emit("identity", { publisher: { login: principal.login, id: principal.id, type: principal.type, admin: publisherRepo.permissions?.admin, push: publisherRepo.permissions?.push }, ordinary: { admin: ordinaryRepo.permissions?.admin, push: ordinaryRepo.permissions?.push } });
  assert.equal(principal.type, "User");
  assert.equal(publisherRepo.permissions?.admin, true, "Publisher credential is not verified admin");
  assert.equal(publisherRepo.permissions?.push, true);
  assert.equal(ordinaryRepo.permissions?.admin, false, "Ordinary credential must be verified non-admin");
  // Repository ACL metadata does not prove this installation token's write scope;
  // the disposable topic create/update below is the required positive control.
  assert.equal(await head(base), env.REVIEWED_SHA, "Fixture must start at reviewed commit");
  await api("ordinary", "GET", `${ROOT}/git/ref/${encodeURIComponent(`heads/${topic}`)}`, undefined, [404]);

  async function readConfiguration() {
    const protection = await get("publisher", `${ROOT}/branches/${encodeURIComponent(base)}/protection`);
    const status = protection.required_status_checks;
    const reviews = protection.required_pull_request_reviews;
    assert.ok(status && reviews, "Required checks or PR requirement missing");
    const bypass = reviews.bypass_pull_request_allowances;
    const classic = {
      enforce_admins: protection.enforce_admins?.enabled,
      required_status_checks: {
        strict: status.strict,
        checks: status.checks.map(({ context, app_id }) => ({ context, app_id })),
      },
      required_pull_request_reviews: {
        dismiss_stale_reviews: reviews.dismiss_stale_reviews,
        require_code_owner_reviews: reviews.require_code_owner_reviews,
        required_approving_review_count: reviews.required_approving_review_count,
        require_last_push_approval: reviews.require_last_push_approval,
        bypass_pull_request_allowances: { users: bypass?.users ?? [], teams: bypass?.teams ?? [], apps: bypass?.apps ?? [] },
      },
      restrictions: protection.restrictions ?? null,
      required_linear_history: protection.required_linear_history?.enabled,
      allow_force_pushes: protection.allow_force_pushes?.enabled,
      allow_deletions: protection.allow_deletions?.enabled,
      required_conversation_resolution: protection.required_conversation_resolution?.enabled,
      lock_branch: protection.lock_branch?.enabled,
      allow_fork_syncing: protection.allow_fork_syncing?.enabled,
    };
    assert.deepEqual(classic, {
      enforce_admins: false,
      required_status_checks: { strict: true, checks: [{ context: CHECK, app_id: APP }] },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true, require_code_owner_reviews: false,
        required_approving_review_count: 0, require_last_push_approval: false,
        bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
      },
      restrictions: null, required_linear_history: false, allow_force_pushes: false,
      allow_deletions: false, required_conversation_resolution: true,
      lock_branch: false, allow_fork_syncing: false,
    }, "Classic protection differs from reviewed settings");
    const contexts = [...(status.contexts ?? [])].sort();
    assert.ok(contexts.every((context) => context === CHECK), "Unexpected legacy required check");
    const effectiveRules = await get("publisher", `${ROOT}/rules/branches/${encodeURIComponent(base)}`);
    assert.deepEqual(effectiveRules.map((rule) => rule.type).sort(), ["deletion", "non_fast_forward"]);
    assert.equal(new Set(effectiveRules.map((rule) => rule.ruleset_id)).size, 1);
    const rulesetId = effectiveRules[0].ruleset_id;
    assert.ok(Number.isSafeInteger(rulesetId) && rulesetId > 0);
    const rule = await get("publisher", `${ROOT}/rulesets/${rulesetId}`);
    assert.equal(rule.id, rulesetId);
    assert.equal(rule.name, rulesetName);
    assert.equal(rule.target, "branch");
    assert.equal(rule.enforcement, "active");
    assert.deepEqual(rule.bypass_actors, [], "No integrity bypass is allowed; missing metadata is not proof");
    assert.deepEqual(rule.conditions.ref_name, { include: [`refs/heads/${base}`], exclude: [] });
    const rules = [...rule.rules].sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(rules, [{ type: "deletion" }, { type: "non_fast_forward" }]);
    return {
      classic, contexts,
      integrity: { id: rule.id, name: rule.name, target: rule.target, enforcement: rule.enforcement, bypass_actors: rule.bypass_actors, conditions: rule.conditions, rules },
    };
  }
  const initialConfiguration = await readConfiguration();
  emit("configuration_verified", { base, configuration: initialConfiguration });

  const original = await head(base);
  const tree = (await get("ordinary", `${ROOT}/git/commits/${original}`)).tree.sha;
  const publisherCommit = await commit(original, tree, "test: disposable publisher fast-forward");
  await denied("ordinary_direct_write_blocked", update("ordinary", base, publisherCommit, false, [403, 409, 422]), original);
  await update("publisher", base, publisherCommit);
  assert.equal(await head(base), publisherCommit);
  emit("publisher_fast_forward_allowed", { sha: publisherCommit });
  await denied("publisher_force_blocked", update("publisher", base, original, true, [403, 409, 422]), publisherCommit, true);
  await denied("publisher_delete_blocked", api("publisher", "DELETE", branchPath(base), undefined, [403, 409, 422]), publisherCommit, true);

  // A positive write control prevents insufficient token scope from looking like protection.
  await api("ordinary", "POST", `${ROOT}/git/refs`, { ref: `refs/heads/${topic}`, sha: publisherCommit }, [201]);
  const marker = { path: `protection-preflight-${env.FIXTURE_KEY}.txt`, mode: "100644", type: "blob", content: "Disposable branch-protection fixture.\n" };
  const goodTree = (await api("publisher", "POST", `${ROOT}/git/trees`, { base_tree: tree, tree: [marker] }, [201])).data.sha;
  const badTree = (await api("publisher", "POST", `${ROOT}/git/trees`, { base_tree: goodTree, tree: [{ path: "registry/domains.txt", mode: "100644", type: "blob", content: "invalid-preflight-row\n" }] }, [201])).data.sha;
  const badCommit = await commit(publisherCommit, badTree, "test: disposable failing Registry checks");
  await update("ordinary", topic, badCommit);
  assert.equal(await head(topic), badCommit);
  emit("ordinary_write_control_passed");
  const pr = (await api("publisher", "POST", `${ROOT}/pulls`, { title: "Disposable branch-protection preflight", head: topic, base, body: "Temporary protection fixture targeting a disposable branch only. Intentionally fails Registry checks before repair. Do not merge into main." }, [201])).data;
  prNumber = pr.number;
  assert.ok(Number.isInteger(prNumber));
  emit("fixture_pr", { number: prNumber, base, topic });

  async function waitCheck(sha, conclusion) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const runs = await get("ordinary", `${ROOT}/actions/workflows/registry-checks.yml/runs?event=pull_request&head_sha=${sha}&per_page=10`);
      const run = runs.workflow_runs.find((item) => item.head_sha === sha && item.event === "pull_request" && item.pull_requests?.some((pull) => pull.number === prNumber));
      if (run?.status === "completed") {
        assert.equal(run.conclusion, conclusion, "Unexpected Registry checks workflow result");
        const jobs = await get("ordinary", `${ROOT}/actions/runs/${run.id}/jobs`);
        const job = jobs.jobs.find((item) => item.name === CHECK);
        assert.equal(job?.conclusion, conclusion);
        const url = new URL(job.check_run_url);
        assert.equal(url.origin, "https://api.github.com");
        assert.ok(url.pathname.startsWith(`${ROOT}/check-runs/`));
        const check = await get("ordinary", url.pathname);
        assert.equal(check.name, CHECK);
        assert.equal(check.app.id, APP);
        assert.equal(check.status, "completed");
        assert.equal(check.conclusion, conclusion);
        emit("registry_check", { sha, conclusion, run_id: run.id, app_id: check.app.id });
        return;
      }
      await sleep(5_000);
    }
    throw new Error("Timed out waiting for the real PR Registry checks");
  }
  async function observePr(sha, expectedState) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await get("ordinary", `${ROOT}/pulls/${prNumber}`);
      assert.equal(current.base.ref, base);
      assert.equal(current.base.repo.full_name, REPO);
      assert.equal(current.head.ref, topic);
      assert.equal(current.head.repo.full_name, REPO);
      assert.equal(current.head.sha, sha);
      assert.equal(current.state, "open");
      if (current.mergeable === false) throw new Error("Fixture has conflicts; PR state is not check evidence");
      if (current.mergeable === true && current.mergeable_state === expectedState) {
        emit("pr_state_observed", { sha, mergeable_state: current.mergeable_state, read_only: true });
        return;
      }
      await sleep(2_000);
    }
    throw new Error("PR state did not settle to the expected check state");
  }
  await waitCheck(badCommit, "failure");
  await observePr(badCommit, "blocked");
  const goodCommit = await commit(badCommit, goodTree, "test: disposable passing Registry checks");
  await update("publisher", topic, goodCommit);
  await waitCheck(goodCommit, "success");
  await observePr(goodCommit, "clean");
  assert.equal(await head(base), publisherCommit, "Disposable base changed during PR observation");
  const finalConfiguration = await readConfiguration();
  assert.deepEqual(finalConfiguration, initialConfiguration, "Protection changed during preflight");
  emit("PASS", {
    base, topic, pr: prNumber, publisher_sha: publisherCommit, checked_head_sha: goodCommit,
    ruleset_id: finalConfiguration.integrity.id, configuration: finalConfiguration,
    completed_at: new Date().toISOString(), pr_state_only: true,
    note: "No PR merge attempted; merge permission not tested. Cleanup remains a separate owner operation",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runPreflight(process.env); }
  catch { console.error("FAIL: protection preflight stopped; use the last metadata event to locate the failing stage. No automatic cleanup or production changes."); process.exitCode = 1; }
}
