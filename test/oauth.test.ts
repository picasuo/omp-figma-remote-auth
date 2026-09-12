import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { DISCOVERY_URL, ENDPOINTS, discoverEndpoints, generatePkce, listenForCallback, parseTokens, runOAuthFlow } from "../src/oauth.ts";
import type { FetchLike } from "../src/oauth.ts";

const metadata = {
  issuer: ENDPOINTS.issuer, authorization_endpoint: ENDPOINTS.authorizationUrl,
  token_endpoint: ENDPOINTS.tokenUrl, registration_endpoint: ENDPOINTS.registrationUrl,
  code_challenge_methods_supported: ["S256"],
};
const tokens = { access_token: "access-value", refresh_token: "refresh-value", token_type: "Bearer", expires_in: 3600 };

function simulatedFigma(options: {
  onRequest?: () => void;
  onRegistration?: (data: Record<string, unknown>) => void;
  onExchange?: (data: URLSearchParams) => void;
  registrationResponse?: (init: RequestInit) => Response | Promise<Response>;
} = {}): FetchLike {
  return async (url, init) => {
    options.onRequest?.();
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url === DISCOVERY_URL) return Response.json(metadata);
    if (url === ENDPOINTS.registrationUrl) {
      assert.equal(init.method, "POST");
      const registration = JSON.parse(String(init.body));
      options.onRegistration?.(registration);
      if (options.registrationResponse) return options.registrationResponse(init);
      return Response.json({ client_id: "test-client", client_secret: "test-secret", client_id_issued_at: 123, client_secret_expires_at: 0 });
    }
    assert.equal(url, ENDPOINTS.tokenUrl);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/x-www-form-urlencoded");
    options.onExchange?.(new URLSearchParams(String(init.body)));
    return Response.json(tokens);
  };
}

function authorizationTarget(callbackUrl: string, state: string): URL {
  const target = new URL(ENDPOINTS.authorizationUrl);
  target.search = new URLSearchParams({
    response_type: "code", client_id: "private-client", redirect_uri: callbackUrl,
    state, code_challenge: generatePkce().challenge, code_challenge_method: "S256",
    scope: "file_read profile", extra: "private-extra+/=&",
  }).toString();
  return target;
}

function assertPrivateHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("connection"), "close");
}

async function authorizationLocation(startUrl: string): Promise<string> {
  const response = await fetch(startUrl, { redirect: "manual" });
  assert.equal(response.status, 302);
  assertPrivateHeaders(response);
  const location = response.headers.get("location");
  assert.ok(location);
  assert.equal(await response.text(), "");
  return location;
}

function assertShortUrl(startUrl: string, callbackUrl: string, target: URL): string {
  const entry = new URL(startUrl);
  assert.ok(startUrl.length <= 55, `entry URL length: ${startUrl.length}`);
  assert.equal(entry.protocol, "http:");
  assert.equal(entry.hostname, "127.0.0.1");
  assert.equal(entry.origin, new URL(callbackUrl).origin);
  assert.equal(entry.search, "");
  assert.equal(entry.hash, "");
  assert.match(entry.pathname, /^\/a\/[A-Za-z0-9_-]{22}$/u);
  const token = entry.pathname.slice(3);
  for (const key of ["state", "code_challenge", "client_id"]) {
    assert.equal(target.searchParams.get(key)!.includes(token), false);
  }
  return token;
}

async function assertUnavailable(...urls: string[]): Promise<void> {
  for (const url of urls) {
    assert.equal(new URL(url).hostname, "127.0.0.1");
    await assert.rejects(fetch(url, { redirect: "manual" }));
  }
}

test("short route preserves the exact authorization target and repeated GETs do not settle", async () => {
  const state = generatePkce().verifier;
  const first = await listenForCallback(0, state, new AbortController().signal);
  const second = await listenForCallback(0, state, new AbortController().signal);
  let settled = false;
  void first.result.then(() => { settled = true; }, () => { settled = true; });
  let startUrl = "";
  let secondStartUrl = "";
  try {
    const target = authorizationTarget(first.callbackUrl, state);
    // Keep noncanonical encoding and extra parameters to detect reconstruction.
    const original = target.href.replace("file_read+profile", "file_read%20profile") + "&extra=second%2fvalue";
    startUrl = first.setAuthorizationUrl(original);
    const otherTarget = new URL(original);
    otherTarget.searchParams.set("redirect_uri", second.callbackUrl);
    secondStartUrl = second.setAuthorizationUrl(otherTarget.href);
    const token = assertShortUrl(startUrl, first.callbackUrl, target);
    const otherToken = assertShortUrl(secondStartUrl, second.callbackUrl, otherTarget);
    assert.notEqual(token, otherToken);
    assert.equal(target.searchParams.get("state"), otherTarget.searchParams.get("state"));
    assert.equal(target.searchParams.get("code_challenge"), otherTarget.searchParams.get("code_challenge"));
    for (let request = 0; request < 2; request++) {
      const location = await authorizationLocation(startUrl);
      assert.equal(location, original);
      assert.deepEqual([...new URL(location).searchParams], [...new URL(original).searchParams]);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, false);
    }
    const response = await fetch(`${first.callbackUrl}?${new URLSearchParams({ state, code: "final-code" })}`);
    assert.equal(response.status, 200);
    assert.equal(await first.result, "final-code");
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  await assertUnavailable(startUrl, first.callbackUrl, secondStartUrl, second.callbackUrl);
});

test("short route rejects missing and wrong tokens, queries, extra paths, bad Host and POST", async () => {
  const state = "private-routing-state";
  const listener = await listenForCallback(0, state, new AbortController().signal);
  let settled = false;
  void listener.result.then(() => { settled = true; }, () => { settled = true; });
  let startUrl = "";
  try {
    const origin = new URL(listener.callbackUrl).origin;
    for (const path of ["/a", "/a/", "/a/AAAAAAAAAAAAAAAAAAAAAA"]) {
      const response = await fetch(origin + path, { redirect: "manual" });
      assert.equal(response.status, 404, `unprepared ${path}`);
      assertPrivateHeaders(response);
      assert.equal(response.headers.get("location"), null);
      await response.text();
    }
    const target = authorizationTarget(listener.callbackUrl, state).href;
    startUrl = listener.setAuthorizationUrl(target);
    const entry = new URL(startUrl);
    const token = entry.pathname.slice(3);
    const wrongToken = (token[0] === "A" ? "B" : "A") + token.slice(1);
    const requests: Array<{ url: string; status: number; init?: RequestInit }> = [
      { url: `${origin}/a`, status: 404 },
      { url: `${origin}/a/`, status: 404 },
      { url: `${origin}/a/${wrongToken}`, status: 404 },
      { url: `${origin}/a/${token.slice(1)}`, status: 404 },
      { url: `${startUrl}?state=${state}`, status: 404 },
      { url: `${startUrl}?token=${token}`, status: 404 },
      { url: `${startUrl}/`, status: 404 },
      { url: `${startUrl}/extra`, status: 404 },
      { url: startUrl, status: 405, init: { method: "POST" } },
    ];
    for (const { url, status, init } of requests) {
      const response = await fetch(url, { ...init, redirect: "manual" });
      assert.equal(response.status, status);
      assertPrivateHeaders(response);
      assert.equal(response.headers.get("location"), null);
      const body = await response.text();
      for (const secret of [state, token, target, "private-client"]) assert.equal(body.includes(secret), false);
    }
    // Node fetch normalizes Host, so use the raw HTTP client for this check.
    await new Promise<void>((resolve, reject) => {
      const req = request(startUrl, { headers: { Host: `localhost:${entry.port}` } }, response => {
        try {
          assert.equal(response.statusCode, 400);
          assert.equal(response.headers.location, undefined);
          response.resume();
          response.on("end", resolve);
        } catch (error) { response.resume(); reject(error); }
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(await authorizationLocation(startUrl), target);
    assert.equal((await fetch(`${listener.callbackUrl}?state=${state}&code=accepted`)).status, 200);
    assert.equal(await listener.result, "accepted");
  } finally { await listener.close(); }
  await assertUnavailable(startUrl, listener.callbackUrl);
});

test("authorization target validation rejects unsafe and malformed targets without binding or leaking secrets", async () => {
  const state = "private-validation-state";
  const listener = await listenForCallback(0, state, new AbortController().signal);
  let startUrl = "";
  try {
    const target = authorizationTarget(listener.callbackUrl, state);
    const invalid: Array<[string, string]> = [["malformed", "private-invalid-url"]];
    const change = (name: string, mutate: (url: URL) => void) => {
      const url = new URL(target);
      mutate(url);
      invalid.push([name, url.href]);
    };
    change("origin", url => { url.hostname = "evil.example"; });
    change("lookalike origin", url => { url.hostname += ".evil.example"; });
    change("protocol", url => { url.protocol = "http:"; });
    change("port", url => { url.port = "444"; });
    change("path", url => { url.pathname += "/extra"; });
    change("username", url => { url.username = "private-user"; });
    change("password", url => { url.password = "private-password"; });
    change("fragment", url => { url.hash = "private-fragment"; });
    invalid.push(["empty fragment", target.href + "#"], ["raw whitespace", target.href + "\n"]);
    const required = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"];
    for (const key of required) {
      change(`missing ${key}`, url => { url.searchParams.delete(key); });
      change(`duplicate ${key}`, url => { url.searchParams.append(key, url.searchParams.get(key)!); });
      change(`conflicting duplicate ${key}`, url => { url.searchParams.append(key, "private-mismatch"); });
      change(`empty ${key}`, url => { url.searchParams.set(key, ""); });
      change(`blank ${key}`, url => { url.searchParams.set(key, " \t"); });
    }
    for (const [key, value] of [
      ["response_type", "token"], ["redirect_uri", `${listener.callbackUrl}/other`],
      ["redirect_uri", "http://127.0.0.1:1/callback"], ["state", "private-mismatch"],
      ["code_challenge_method", "plain"], ["code_challenge_method", "s256"],
    ]) change(`mismatched ${key}: ${value}`, url => { url.searchParams.set(key, value); });
    for (const [name, value] of invalid) {
      assert.throws(() => listener.setAuthorizationUrl(value), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid Figma authorization target.", name);
        for (const secret of [state, target.href, "private-client", "private-extra", "private-user", "private-password", "private-fragment", "private-mismatch"]) {
          assert.equal(error.message.includes(secret), false, name);
        }
        return true;
      }, name);
    }
    startUrl = listener.setAuthorizationUrl(target.href);
    for (const value of [target.href, target.href + "&extra=private-replacement"]) {
      assert.throws(() => listener.setAuthorizationUrl(value), { message: "Figma authorization entry is already bound or closed." });
    }
    assert.equal(await authorizationLocation(startUrl), target.href);
  } finally { await listener.close(); }
  await assert.rejects(listener.result, /cancelled/u);
  await assertUnavailable(startUrl, listener.callbackUrl);
});

test("timeout after authorization is ready closes both routes without exchange or unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  let startUrl = "";
  let callbackUrl = "";
  try {
    await assert.rejects(runOAuthFlow({
      clientName: "Codex", port: 0, timeoutMs: 250,
      fetch: simulatedFigma({ onExchange: () => assert.fail("must not exchange") }),
      onAuthorizationReady: async entry => {
        startUrl = entry.startUrl;
        callbackUrl = entry.callbackUrl;
        await authorizationLocation(startUrl);
      },
    }), /timed out/u);
    await assertUnavailable(startUrl, callbackUrl);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", observe); }
});

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
  let startUrl = "";
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
    onAuthorizationReady: async entry => {
      startUrl = entry.startUrl;
      callback = entry.callbackUrl;
      authorize = new URL(await authorizationLocation(startUrl));
      assert.equal(authorize.origin + authorize.pathname, ENDPOINTS.authorizationUrl);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorize.searchParams.get("response_type"), "code");
      assert.equal(authorize.searchParams.get("client_id"), "test-client");
      assert.equal(authorize.searchParams.get("redirect_uri"), callback);
      assert.match(authorize.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/u);
      assertShortUrl(startUrl, callback, authorize);
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
      assert.equal((await fetch(`${callback}?code=x`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&state=${state}&code=x`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&code=x&iss=https://evil.example`)).status, 400);
      assert.equal((await fetch(`${callback}?state=${state}&code=x&iss=${encodeURIComponent(ENDPOINTS.issuer)}&iss=${encodeURIComponent(ENDPOINTS.issuer)}`)).status, 400);
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
  await assertUnavailable(startUrl, callback);
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
    fetch: simulatedFigma({
      onRegistration: data => { callback = (data.redirect_uris as string[])[0]!; },
      registrationResponse: () => Response.json({ error: "invalid_client", error_description: secret, access_token: secret }, { status: 400 }),
      onExchange: () => assert.fail("DCR failed"),
    }),
    onAuthorizationReady: () => assert.fail("DCR failed"),
  }), error => {
    assert.equal((error as Error).message, "OAuth HTTP 400: invalid_client.");
    assert.equal((error as Error).message.includes(secret), false);
    return true;
  });
  await assert.rejects(fetch(callback));
});

test("valid-state denial is sanitized and stops the flow without exchange", async () => {
  let callback = "";
  let startUrl = "";
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, fetch: simulatedFigma({ onExchange: () => assert.fail("must not exchange") }),
    onAuthorizationReady: async entry => {
      startUrl = entry.startUrl;
      callback = entry.callbackUrl;
      const state = new URL(await authorizationLocation(startUrl)).searchParams.get("state")!;
      const response = await fetch(`${callback}?state=${state}&error=secret-token-code&error_description=very-secret`);
      assert.equal(response.status, 400);
      assert.equal(await response.text(), "Authorization was not granted. Return to OMP.");
    },
  }), /OAuth callback: oauth_error\./u);
  await assertUnavailable(startUrl, callback);
});

test("timeout cancels pending registration and closes the listener without unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const observe = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", observe);
  let callback = "";
  let requestSignal: AbortSignal | null | undefined;
  try {
    await assert.rejects(runOAuthFlow({
      clientName: "Codex", port: 0, timeoutMs: 100,
      fetch: simulatedFigma({
        onRegistration: data => { callback = (data.redirect_uris as string[])[0]!; },
        registrationResponse: async init => {
          requestSignal = init.signal;
          return await new Promise<Response>(() => {}); // Deliberately ignores abort.
        },
        onExchange: () => assert.fail("registration never completes"),
      }),
      onAuthorizationReady: () => assert.fail("registration never completes"),
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
  let startUrl = "";
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, signal: controller.signal, fetch: simulatedFigma(),
    onAuthorizationReady: async entry => {
      startUrl = entry.startUrl;
      callback = entry.callbackUrl;
      await authorizationLocation(startUrl);
      controller.abort(new Error("private reason"));
    },
  }), /cancelled/u);
  await assertUnavailable(startUrl, callback);
  await assert.rejects(runOAuthFlow({
    clientName: "Codex", port: 0, signal: controller.signal,
    fetch: simulatedFigma({ onRequest: () => assert.fail("pre-aborted flow must not fetch") }),
    onAuthorizationReady: () => assert.fail("pre-aborted flow must not become ready"),
  }), /cancelled/u);
});

test("occupied callback port rejects cleanly and close is idempotent", async () => {
  const controller = new AbortController();
  const first = await listenForCallback(0, "test-state", controller.signal);
  const startUrl = first.setAuthorizationUrl(authorizationTarget(first.callbackUrl, "test-state").href);
  try {
    await assert.rejects(listenForCallback(Number(new URL(first.callbackUrl).port), "state-2", controller.signal), /bind/u);
  } finally {
    await first.close();
    await first.close();
  }
  await assert.rejects(first.result, /cancelled/u);
  await assertUnavailable(startUrl, first.callbackUrl);
  assert.throws(() => first.setAuthorizationUrl(authorizationTarget(first.callbackUrl, "test-state").href), /already bound or closed/u);
});
