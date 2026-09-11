import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DISCOVERY_URL, ENDPOINTS, discoverEndpoints, generatePkce, listenForCallback, parseTokens, runOAuthFlow } from "../src/oauth.ts";
import type { FetchLike } from "../src/oauth.ts";

const metadata = {
  issuer: ENDPOINTS.issuer, authorization_endpoint: ENDPOINTS.authorizationUrl,
  token_endpoint: ENDPOINTS.tokenUrl, registration_endpoint: ENDPOINTS.registrationUrl,
  code_challenge_methods_supported: ["S256"],
};
const tokens = { access_token: "access-value", refresh_token: "refresh-value", token_type: "Bearer", expires_in: 3600 };

function simulatedFigma(options: { onRegistration?: (data: Record<string, unknown>) => void; onExchange?: (data: URLSearchParams) => void } = {}): FetchLike {
  return async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url === DISCOVERY_URL) return Response.json(metadata);
    if (url === ENDPOINTS.registrationUrl) {
      assert.equal(init.method, "POST");
      const registration = JSON.parse(String(init.body));
      options.onRegistration?.(registration);
      return Response.json({ client_id: "test-client", client_secret: "test-secret", client_id_issued_at: 123, client_secret_expires_at: 0 });
    }
    assert.equal(url, ENDPOINTS.tokenUrl);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    options.onExchange?.(new URLSearchParams(String(init.body)));
    return Response.json(tokens);
  };
}

test("PKCE uses fresh high-entropy base64url verifiers and S256", () => {
  const a = generatePkce();
  const b = generatePkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(a.verifier, b.verifier);
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
});

test("DCR shape, callback validation, secret exchange, expiry mapping, and listener cleanup", async () => {
  let registration: Record<string, unknown> | undefined;
  let authorize: URL | undefined;
  let callback = "";
  let exchanged = false;
  const grant = await runOAuthFlow({
    clientName: "Codex", port: 0, timeoutMs: 3000, now: () => 1_700_000_000_000,
    fetch: simulatedFigma({
      onRegistration: data => { registration = data; },
      onExchange: form => {
        exchanged = true;
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("client_id"), "test-client");
        assert.equal(form.get("client_secret"), "test-secret");
        assert.equal(form.get("code"), "good-code");
        assert.equal(form.get("redirect_uri"), callback);
        assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), authorize!.searchParams.get("code_challenge"));
        assert.equal(form.has("state"), false);
      },
    }),
    onAuthorizationUrl: async (url, callbackUrl) => {
      authorize = new URL(url);
      callback = callbackUrl;
      assert.equal(authorize.origin + authorize.pathname, ENDPOINTS.authorizationUrl);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.match(authorize.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(authorize.searchParams.has("client_secret"), false);
      assert.equal(new URL(callback).hostname, "127.0.0.1");
      assert.notEqual(new URL(callback).port, "0");
      const state = authorize.searchParams.get("state")!;
      const base = new URL(callback);
      assert.equal((await fetch(`${base.origin}/wrong?state=${state}&code=x`)).status, 404);
      assert.equal((await fetch(`${callback}?state=${state}&code=x`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${callback}?state=wrong&error=access_denied&error_description=secret`)).status, 400);
      assert.equal((await fetch(`${callback}?state=wrong&code=x`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&state=${state}&code=x`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&code=x&iss=https://evil.example`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&code=good-code&iss=${encodeURIComponent(ENDPOINTS.issuer)}`)).status, 200);
    },
  });
  assert.deepEqual(registration, {
    redirect_uris: [callback], client_name: "Codex",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  });
  assert.ok(exchanged);
  assert.equal(grant.access, "access-value");
  assert.equal(grant.refresh, "refresh-value");
  assert.equal(grant.expires, 1_700_003_600_000);
  assert.equal(grant.clientSecret, "test-secret");
  assert.equal(grant.clientSecretExpiresAt, 0);
  assert.equal(grant.tokenUrl, ENDPOINTS.tokenUrl);
  await assert.rejects(fetch(callback));
});

test("discovery rejects malicious origins, alternate paths, userinfo, ports, and missing S256", async () => {
  for (const change of [
    { token_endpoint: "https://evil.example/token" },
    { registration_endpoint: "https://api.figma.com.evil.example/register" },
    { authorization_endpoint: "https://www.figma.com/other" },
    { token_endpoint: "https://user@api.figma.com/v1/oauth/token" },
    { token_endpoint: "https://api.figma.com:443/v1/oauth/token" },
    { issuer: "https://evil.example" },
    { code_challenge_methods_supported: ["plain"] },
  ]) {
    await assert.rejects(discoverEndpoints(async () => Response.json({ ...metadata, ...change }), new AbortController().signal), /untrusted endpoint|S256/u);
  }
});

test("token validation rejects missing refresh, wrong type, unsafe expiry and malformed fields", () => {
  for (const change of [
    { access_token: "" }, { refresh_token: undefined }, { refresh_token: "" },
    { token_type: "Basic" }, { token_type: undefined }, { expires_in: undefined },
    { expires_in: -1 }, { expires_in: 0 }, { expires_in: 1.5 },
    { expires_in: Infinity }, { expires_in: Number.MAX_SAFE_INTEGER },
    { expires_in: "1e100" }, { scope: 42 },
  ]) assert.throws(() => parseTokens({ ...tokens, ...change }, Date.now()));
  assert.equal(parseTokens({ ...tokens, expires_in: "10" }, 1000).expires, 11000);
});

test("OAuth errors expose only HTTP status and allowlisted error fields", async () => {
  const secret = "server-secret-access-code";
  let callback = "";
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0,
    fetch: async (url, init) => {
      if (url === DISCOVERY_URL) return Response.json(metadata);
      callback = JSON.parse(String(init.body)).redirect_uris[0];
      return Response.json({ error: "invalid_client", error_description: secret, access_token: secret }, { status: 400 });
    },
    onAuthorizationUrl: () => assert.fail("DCR failed"),
  }), error => {
    assert.equal((error as Error).message, "OAuth HTTP 400: invalid_client.");
    assert.equal((error as Error).message.includes(secret), false);
    return true;
  });
  await assert.rejects(fetch(callback));
});

test("valid-state denial is sanitized and stops the flow without exchange", async () => {
  let callback = "";
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, fetch: simulatedFigma({ onExchange: () => assert.fail("must not exchange") }),
    onAuthorizationUrl: async (url, cb) => {
      callback = cb;
      const state = new URL(url).searchParams.get("state")!;
      await fetch(`${cb}?state=${state}&error=secret-token-code&error_description=very-secret`);
    },
  }), /OAuth callback: oauth_error\./u);
  await assert.rejects(fetch(callback));
});

test("timeout cancels a pending discovery and closes the listener without unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  let callback = "";
  let requestSignal: AbortSignal | null | undefined;
  try {
    await assert.rejects(runOAuthFlow({
      clientName: "Codex", port: 0, timeoutMs: 100,
      fetch: async (url, init) => {
        if (url === DISCOVERY_URL) return Response.json(metadata);
        callback = JSON.parse(String(init.body)).redirect_uris[0];
        requestSignal = init.signal;
        return await new Promise<Response>(() => {}); // Deliberately ignores abort.
      },
      onAuthorizationUrl: () => assert.fail("registration never completes"),
    }), /timed out/u);
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(fetch(callback));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", observe); }
});

test("external cancellation while awaiting callback cleans up; pre-abort makes no requests", async () => {
  const controller = new AbortController();
  let callback = "";
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, signal: controller.signal, fetch: simulatedFigma(),
    onAuthorizationUrl: (_url, cb) => { callback = cb; controller.abort(new Error("private reason")); },
  }), /cancelled/u);
  await assert.rejects(fetch(callback));
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, signal: controller.signal,
    fetch: async () => assert.fail("pre-aborted flow must not fetch"), onAuthorizationUrl: () => {},
  }), /cancelled/u);
});

test("occupied callback port rejects cleanly and close is idempotent", async () => {
  const controller = new AbortController();
  const first = await listenForCallback(0, "test-state", controller.signal);
  try {
    await assert.rejects(listenForCallback(Number(new URL(first.callbackUrl).port), "state-2", controller.signal), /bind/u);
  } finally {
    await first.close();
    await first.close();
  }
  await assert.rejects(first.result, /cancelled/u);
});
