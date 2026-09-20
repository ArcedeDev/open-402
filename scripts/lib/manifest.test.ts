import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { crawlDomain, isPublicAddress, isPublicDomain, validateManifest } from "./manifest.ts";

const domain = "api.vendor.io";
const manifest = { version: "1.3", origin: domain, payout_address: "0x1111111111111111111111111111111111111111" };

function transport(responses: { body?: string; status?: number; headers?: Record<string, string>; stall?: boolean; abort?: boolean }[], addresses = ["8.8.8.8"]) {
  const calls: string[] = [];
  const sockets: string[] = [];
  const request = (url, options, receive) => {
    calls.push(url.href);
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    let response: PassThrough | undefined;
    const abort = () => {
      response?.destroy();
      req.emit("error", new Error("aborted"));
    };
    options.signal.addEventListener("abort", abort, { once: true });
    req.end = () => queueMicrotask(() => {
      options.lookup(url.hostname, { all: true }, (error, records) => {
        if (error) { options.signal.removeEventListener("abort", abort); req.emit("error", error); return; }
        sockets.push(...records.map((record) => record.address));
        const spec = responses.shift() ?? {};
        response = new PassThrough();
        Object.assign(response, { statusCode: spec.status ?? 200, headers: { "content-type": "application/json", ...spec.headers } });
        response.on("close", () => options.signal.removeEventListener("abort", abort));
        receive(response);
        if (spec.abort) { response.emit("aborted"); response.destroy(); }
        else if (!spec.stall) response.end(spec.body ?? JSON.stringify(manifest));
      });
    });
    return req;
  };
  const lookup = async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  return { calls, sockets, options: { request, lookup } };
}

test("official validator accepts supported versions and custom payment protocols", () => {
  for (const version of ["1.0", "1.1", "1.2", "1.3", "1.4"]) {
    assert.equal(validateManifest({ ...manifest, version }, domain).success, true);
  }
  assert.equal(validateManifest({ ...manifest, payments: { custom: { network: "nano:mainnet" } } }, domain).success, true);
});

test("truthy version, A2A cards, malformed schema and origin mismatches are not verified", () => {
  for (const value of [null, [], { version: true }, { version: "1.3.6", skills: [] },
    { ...manifest, intents: [null] }, { ...manifest, payout_address: "" },
    { ...manifest, origin: "other.vendor.io" }, { ...manifest, origin: "vendor.io" }]) {
    assert.equal(validateManifest(value, domain).success, false);
  }
});

test("domain and IP policies reject reserved, private and mapped destinations", () => {
  for (const name of ["example.com", "a.example.org", "localhost", "a.internal", "a.test", "127.1", "127.0.0.1", "[::1]", "x@y.io", "a.io:443", "bad_label.io", "a.io/path"]) assert.equal(isPublicDomain(name), false, name);
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.0.1", "::1", "fc00::1", "fe80::1", "fec0::1", "64:ff9b:1::a9fe:a9fe", "::ffff:127.0.0.1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicDomain("xn--bcher-kva.de"), true);
  assert.equal(isPublicAddress("3fff::1"), false);
  assert.equal(isPublicAddress("5f00::1"), false);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("a stalled response body reaches an explicit timeout outcome", async () => {
  const fixture = transport([{ stall: true }]);
  const start = Date.now();
  const result = await crawlDomain(domain, { ...fixture.options, timeoutMs: 30 });
  assert.equal(result.error, "timeout");
  assert.ok(Date.now() - start < 1000);
});

test("streamed body size is enforced in bytes, including Unicode and exact boundary", async () => {
  const body = JSON.stringify({ ...manifest, description: "é" });
  for (const maxBytes of [Buffer.byteLength(body), Buffer.byteLength(body) - 1]) {
    const fixture = transport([{ body }]);
    const result = await crawlDomain(domain, { ...fixture.options, maxBytes });
    assert.equal(result.success, maxBytes === Buffer.byteLength(body));
    if (!result.success) assert.equal(result.error, "too_large");
  }
});

test("malformed JSON, status, compression and aborted bodies fail without hanging", async () => {
  for (const spec of [{ body: "{" }, { status: 402 }, { headers: { "content-type": "text/html" } },
    { headers: { "content-encoding": "gzip" } }, { abort: true }]) {
    assert.equal((await crawlDomain(domain, transport([spec]).options)).success, false);
  }
});

test("redirects share the deadline and cannot switch protocol, credentials or network boundary", async () => {
  for (const location of ["http://other.vendor.io/agent.json", "https://user:secret@other.vendor.io/agent.json", "https://other.vendor.io:8443/agent.json", "https://127.0.0.1/agent.json"]) {
    const fixture = transport([{ status: 302, headers: { location } }]);
    assert.equal((await crawlDomain(domain, fixture.options)).success, false);
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = transport([{ status: 302, headers: { location: "/manifest.json" } }, { stall: true }]);
  assert.equal((await crawlDomain(domain, { ...fixture.options, timeoutMs: 30 })).error, "timeout");
  const repeated = transport(Array.from({ length: 2 }, () => ({ status: 302, headers: { location: "/again.json" } })));
  assert.equal((await crawlDomain(domain, repeated.options)).error, "too_many_redirects");
  assert.equal(repeated.calls.length, 2);
});

test("socket lookup rejects mixed public/private DNS answers and binds public addresses", async () => {
  const blocked = transport([{}], ["8.8.8.8", "127.0.0.1"]);
  assert.equal((await crawlDomain(domain, blocked.options)).error, "blocked_address");
  assert.deepEqual(blocked.sockets, []);
  const allowed = transport([{}]);
  assert.equal((await crawlDomain(domain, allowed.options)).success, true);
  assert.deepEqual(allowed.sockets, ["8.8.8.8"]);
  for (const address of ["fec0::1", "64:ff9b:1::a9fe:a9fe"]) {
    const special = transport([{}], [address]);
    assert.equal((await crawlDomain(domain, special.options)).error, "blocked_address");
    assert.deepEqual(special.sockets, []);
  }
});

test("DNS failures and empty answers become bounded failures", async () => {
  const empty = transport([{}], []);
  assert.equal((await crawlDomain(domain, empty.options)).error, "blocked_address");
  const failed = transport([{}]);
  assert.equal((await crawlDomain(domain, { ...failed.options, lookup: async () => { throw new Error("DNS failed"); } })).error, "request_failed");
});
