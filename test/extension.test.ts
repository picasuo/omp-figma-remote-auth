import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerExtension } from "../index.ts";
import type { CommandContext, Dependencies, ExtensionAPI } from "../index.ts";
import { DISCOVERY_URL, ENDPOINTS, runOAuthFlow } from "../src/oauth.ts";
import { UserError } from "../src/args.ts";
import type { FlowOptions, OAuthGrant } from "../src/oauth.ts";
import { legacyCredentialIdFor, nativeCredentialIdFor, OWNER, resolveActiveProfile } from "../src/storage.ts";
import type { Credential } from "../src/storage.ts";

const grant: OAuthGrant = {
  clientId: "test-client", clientSecret: "test-secret",
  access: "test-access", refresh: "test-refresh", expires: 4_000_000_000_000,
  tokenUrl: ENDPOINTS.tokenUrl, authorizationUrl: ENDPOINTS.authorizationUrl,
};
const entry = { startUrl: "http://127.0.0.1:1234/a/abcdefghijklmnopqrstuv", callbackUrl: "http://127.0.0.1:1234/callback" };
const widgetKey = "figma-remote-auth";

function fixture(runOAuth: NonNullable<Dependencies["runOAuth"]>) {
  const dir = mkdtempSync(join(tmpdir(), "figma-extension-"));
  const credentials = new Map<string, Credential>();
  const notifications: Array<{ text: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const events: string[] = [];
  const widgetCalls: Array<{ key: string; factory: (() => unknown) | undefined; options: { placement: "aboveEditor" } | undefined }> = [];
  const markdownArgs: unknown[][] = [];
  const widgets = new Map<string, unknown>();
  const theme = { fixtureTheme: true };
  const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  let commandName = "";
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let shutdown!: () => void | Promise<void>;
  const ctx: CommandContext = {
    hasUI: true, mode: "tui",
    modelRegistry: { authStorage: {
      get: id => credentials.get(id),
      set: async (id, value) => { credentials.set(id, value); },
      remove: async id => { credentials.delete(id); },
    } },
    ui: {
      notify: (text, level) => { notifications.push({ text, level }); },
      setStatus: (key, value) => { events.push(value ? "status:set" : "status:clear"); statuses.set(key, value); },
      setWidget: (key, factory, options) => {
        events.push(factory ? "widget:set" : "widget:clear");
        widgetCalls.push({ key, factory, options });
        if (factory) widgets.set(key, factory());
        else widgets.delete(key);
      },
    },
  };
  const api: ExtensionAPI = {
    pi: {
      getAgentDir: () => dir,
      Markdown: class {
        constructor(...args: [string, number, number, unknown]) { markdownArgs.push(args); }
      },
      getMarkdownTheme: () => theme,
    },
    exec: async (command, args, options) => {
      events.push("exec");
      execCalls.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    registerCommand(name, value) { commandName = name; command = value; },
    on(event, handler) { assert.equal(event, "session_shutdown"); shutdown = handler; },
  };
  registerExtension(api, { runOAuth, platform: "darwin" });
  return {
    dir, credentials, notifications, statuses, commandName, ctx, api,
    events, widgetCalls, markdownArgs, widgets, theme, execCalls,
    run: (args: string) => command.handler(args, ctx),
    shutdown: () => shutdown(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Top-level tests run serially: the extension intentionally owns one process-wide login.
test("registered commands authorize, report status and remove native credentials", async () => {
  let options: FlowOptions | undefined;
  const host = fixture(async value => {
    options = value;
    await value.onAuthorizationReady({ startUrl: "http://127.0.0.1:1234/a/abcdefghijklmnopqrstuv", callbackUrl: "http://127.0.0.1:1234/callback" });
    return grant;
  });
  try {
    assert.equal(host.commandName, "figma-remote-auth");
    await host.run("help");
    assert.deepEqual(
      host.notifications.at(-1)!.text.split("\n").filter(line => line.startsWith("/figma-remote-auth ")).map(line => line.split(" ")[1]),
      ["help", "login", "status", "logout", "cancel"],
    );
    assert.equal(existsSync(join(host.dir, "mcp.json")), false);
    await host.run("login --port 0");
    assert.equal(options?.clientName, "Codex");
    assert.equal(options?.port, 0);
    const saved = host.credentials.get(nativeCredentialIdFor(resolveActiveProfile()));
    assert.equal(saved?.access, grant.access);
    assert.equal(saved?.refresh, grant.refresh);
    assert.equal(saved?.clientSecret, grant.clientSecret);
    assert.equal(saved?.type, "oauth");
    assert.equal(existsSync(join(host.dir, "mcp.json")), false);
    await host.run("status");
    assert.match(host.notifications.at(-1)!.text, /Credential: present/);
    for (const note of host.notifications) {
      assert.ok(!note.text.includes(grant.access));
      assert.ok(!note.text.includes(grant.refresh));
      assert.ok(!note.text.includes(grant.clientSecret!));
    }
    await host.run("logout");
    assert.equal(host.credentials.size, 0);
    await host.run("status");
    assert.match(host.notifications.at(-1)!.text, /not logged in/);
    assert.equal(host.statuses.get("figma-remote-auth"), undefined);
  } finally {
    await host.shutdown();
    host.cleanup();
  }
});

test("login migrates legacy data before authorization and status is read-only", async () => {
  let authorizations = 0;
  const renewedGrant = { ...grant, access: "renewed-access", refresh: "renewed-refresh" };
  const host = fixture(async () => {
    authorizations++;
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), retained);
    assert.equal(host.credentials.has(legacyId), false);
    assert.equal(host.credentials.get(nativeCredentialIdFor(resolveActiveProfile()))?.access, grant.access);
    return renewedGrant;
  });
  const legacyId = legacyCredentialIdFor(host.dir);
  const path = join(host.dir, "mcp.json");
  const retained = { $schema: "fixture-schema", mcpServers: { other: { enabled: false } } };
  const original = JSON.stringify({ ...retained, mcpServers: { ...retained.mcpServers,
    figma: { type: "http", url: "https://mcp.figma.com/mcp", auth: { type: "oauth", credentialId: legacyId } },
  } });
  writeFileSync(path, original);
  host.credentials.set(legacyId, { ...grant, type: "oauth", figmaRemoteAuthOwner: OWNER, figmaRemoteAuthCredentialId: legacyId });
  try {
    await host.run("status");
    assert.match(host.notifications.at(-1)!.text, /package-provided[\s\S]*migration pending/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(host.credentials.size, 1);
    await host.run("login");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), retained);
    assert.equal(host.credentials.has(legacyId), false);
    assert.equal(authorizations, 1);
    assert.equal(host.credentials.get(nativeCredentialIdFor(resolveActiveProfile()))?.access, renewedGrant.access);
    assert.equal(host.notifications.at(-1)!.text, "Figma authorization saved. Run /mcp reload.");
  } finally { await host.shutdown(); host.cleanup(); }
});

test("concurrent login is rejected; cancel waits for cleanup and permits a later login", { timeout: 3000 }, async () => {
  const started = deferred<FlowOptions>();
  const pending = deferred<OAuthGrant>();
  let calls = 0;
  const host = fixture(options => {
    calls++;
    if (calls > 1) return Promise.resolve(grant);
    started.resolve(options);
    return pending.promise;
  });
  const login = host.run("login");
  try {
    const options = await started.promise;
    await host.run("login");
    assert.equal(calls, 1);
    assert.match(host.notifications.at(-1)!.text, /already running/);
    let cancelFinished = false;
    const cancel = host.run("cancel").then(() => { cancelFinished = true; });
    assert.equal(options.signal?.aborted, true);
    await Promise.resolve();
    assert.equal(cancelFinished, false);
    pending.reject(new Error("test cancellation"));
    await Promise.all([login, cancel]);
    assert.equal(host.credentials.size, 0);
    assert.equal(host.statuses.get("figma-remote-auth"), undefined);
    await host.run("login");
    assert.equal(calls, 2);
    assert.equal(host.credentials.size, 1);
  } finally {
    pending.reject(new Error("test cleanup"));
    await login;
    await host.shutdown();
    host.cleanup();
  }
});

test("session shutdown aborts login, waits for cleanup, and prevents subsequent mutations", { timeout: 3000 }, async () => {
  const started = deferred<FlowOptions>();
  const pending = deferred<OAuthGrant>();
  const host = fixture(options => { started.resolve(options); return pending.promise; });
  const login = host.run("login");
  try {
    const options = await started.promise;
    let shutdownFinished = false;
    const shutdown = Promise.resolve(host.shutdown()).then(() => { shutdownFinished = true; });
    assert.equal(options.signal?.aborted, true);
    await Promise.resolve();
    assert.equal(shutdownFinished, false);
    // Even an OAuth implementation that resolves after cancellation must not persist its grant.
    pending.resolve(grant);
    await Promise.all([login, shutdown]);
    assert.equal(host.credentials.size, 0);
    await host.run("login");
    assert.match(host.notifications.at(-1)!.text, /shutting down/);
  } finally {
    pending.resolve(grant);
    await login;
    await host.shutdown();
    host.cleanup();
  }
});

test("interactive login renders the Markdown factory before opening the exact short entry", async () => {
  const ready = deferred<void>();
  const result = deferred<OAuthGrant>();
  let options!: FlowOptions;
  const host = fixture(async value => {
    options = value;
    await value.onAuthorizationReady(entry);
    ready.resolve();
    return result.promise;
  });
  const login = host.run("login");
  try {
    await ready.promise;
    assert.deepEqual(host.events, ["status:set", "widget:set", "exec"]);
    assert.equal(host.widgets.size, 1);
    assert.equal(host.widgetCalls[0].key, widgetKey);
    assert.equal(typeof host.widgetCalls[0].factory, "function");
    assert.deepEqual(host.widgetCalls[0].options, { placement: "aboveEditor" });
    assert.deepEqual(host.markdownArgs, [[
      '**[点击这里授权 Figma](<' + entry.startUrl + '>)**\n\n浏览器未自动打开时，点击上方入口。取消：/figma-remote-auth cancel',
      1, 0, host.theme,
    ]]);
    assert.deepEqual(host.execCalls, [{ command: "open", args: [entry.startUrl], options: { timeout: 5000, signal: options.signal } }]);
    await options.onAuthorizationReady(entry);
    assert.equal(host.widgetCalls.length, 1);
    assert.equal(host.execCalls.length, 1);
    result.resolve(grant);
    await login;
    assert.deepEqual(host.events.slice(-2), ["widget:clear", "status:clear"]);
    assert.equal(host.widgets.size, 0);
  } finally { result.resolve(grant); await login; await host.shutdown(); host.cleanup(); }
});

for (const mode of ["tui-no-browser", "rpc", "print", "tui-no-ui", "unknown"]) {
  test(`${mode} never executes a browser`, async () => {
    const host = fixture(async options => { await options.onAuthorizationReady(entry); return grant; });
    host.ctx.mode = mode.startsWith("tui") ? "tui" : mode;
    host.ctx.hasUI = mode !== "tui-no-ui";
    try {
      await host.run(mode === "tui-no-browser" ? "login --no-browser" : "login");
      assert.equal(host.execCalls.length, 0);
      if (mode === "tui-no-browser") assert.equal(host.markdownArgs.length, 1);
      else {
        assert.equal(host.widgetCalls.length, 0);
        assert.ok(host.notifications.some(note => note.text.includes(entry.startUrl)));
        assert.ok(host.notifications.every(note => !note.text.includes("[点击")));
      }
    } finally { await host.shutdown(); host.cleanup(); }
  });
}

for (const missing of ["widget", "Markdown", "theme", "throwing-widget"] as const) {
  test(`missing ${missing} support displays the full plain short URL and host notice`, async () => {
    const host = fixture(async options => { await options.onAuthorizationReady(entry); return grant; });
    if (missing === "widget") delete host.ctx.ui.setWidget;
    if (missing === "Markdown") delete host.api.pi.Markdown;
    if (missing === "theme") delete host.api.pi.getMarkdownTheme;
    if (missing === "throwing-widget") host.ctx.ui.setWidget = () => { throw new Error("disposed UI"); };
    try {
      await host.run("login --no-browser");
      assert.ok(host.notifications.some(note => note.text.includes(`\n${entry.startUrl}\n`)));
      assert.ok(host.notifications.some(note => /host does not support/.test(note.text)));
      assert.equal(host.execCalls.length, 0);
      assert.equal(host.credentials.size, 1);
    } finally { await host.shutdown(); host.cleanup(); }
  });
}

for (const invalid of [
  { startUrl: "https://www.figma.com/oauth/mcp?client_id=secret&state=secret&code_challenge=secret", callbackUrl: entry.callbackUrl },
  { startUrl: entry.startUrl + "?state=secret", callbackUrl: entry.callbackUrl },
  { ...entry, callbackUrl: "http://127.0.0.1:9999/callback" },
]) {
  test("invalid authorization entries never reach UI or exec", async () => {
    const host = fixture(async options => { await options.onAuthorizationReady(invalid); return grant; });
    try {
      await host.run("login");
      assert.equal(host.widgetCalls.length, 0);
      assert.equal(host.execCalls.length, 0);
      assert.equal(host.credentials.size, 0);
      assert.match(host.notifications.at(-1)!.text, /Invalid local Figma authorization entry/);
      assert.doesNotMatch(JSON.stringify(host.notifications), /www\.figma\.com\/oauth\/mcp|client_id|state=|code_challenge/);
    } finally { await host.shutdown(); host.cleanup(); }
  });
}

// Only loopback requests use real fetch. Every remote OAuth endpoint is supplied by this stub.
for (const outcome of ["success", "failure", "timeout", "cancel", "shutdown"] as const) {
  test(`real loopback ${outcome} clears UI; failed browser execution preserves the listener`, { timeout: 5000 }, async () => {
    const ready = deferred<{ startUrl: string; callbackUrl: string }>();
    const remoteCalls: string[] = [];
    const host = fixture(options => runOAuthFlow({
      ...options, timeoutMs: outcome === "timeout" ? 500 : 3000,
      fetch: async url => {
        remoteCalls.push(url);
        if (url === DISCOVERY_URL) return Response.json({
          issuer: ENDPOINTS.issuer, authorization_endpoint: ENDPOINTS.authorizationUrl,
          token_endpoint: ENDPOINTS.tokenUrl, registration_endpoint: ENDPOINTS.registrationUrl,
          code_challenge_methods_supported: ["S256"],
        });
        if (url === ENDPOINTS.registrationUrl) return Response.json({ client_id: grant.clientId });
        assert.equal(url, ENDPOINTS.tokenUrl);
        return Response.json({ access_token: grant.access, refresh_token: grant.refresh, token_type: "Bearer", expires_in: 3600 });
      },
      onAuthorizationReady: async value => { await options.onAuthorizationReady(value); ready.resolve(value); },
    }));
    const captureExec = host.api.exec!;
    host.api.exec = async (...args) => {
      await captureExec(...args);
      return { stdout: "", stderr: "https://www.figma.com/oauth/mcp?client_id=secret&state=secret&code_challenge=secret", code: 1, killed: false };
    };
    const login = host.run("login --port 0");
    try {
      const local = await ready.promise;
      assert.equal(host.widgets.size, 1);
      assert.ok(host.notifications.some(note => /authorization is still waiting/.test(note.text)));
      assert.deepEqual(host.execCalls[0].args, [local.startUrl]);
      // A manual redirect avoids following the real Figma authorization endpoint.
      const redirect = await fetch(local.startUrl, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      const authorization = new URL(redirect.headers.get("location")!);
      assert.equal(authorization.origin + authorization.pathname, ENDPOINTS.authorizationUrl);
      const callback = new URL(local.callbackUrl);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      if (outcome === "success" || outcome === "failure") {
        callback.searchParams.set(outcome === "success" ? "code" : "error", outcome === "success" ? "test-code" : "access_denied");
        const response = await fetch(callback);
        assert.equal(response.status, outcome === "success" ? 200 : 400);
      } else if (outcome === "cancel") await host.run("cancel");
      else if (outcome === "shutdown") await host.shutdown();
      await login;
      assert.equal(host.widgets.size, 0);
      assert.equal(host.statuses.get(widgetKey), undefined);
      assert.equal(host.widgetCalls.at(-1)!.factory, undefined);
      assert.equal(host.credentials.size, outcome === "success" ? 1 : 0);
      if (outcome === "timeout") assert.match(host.notifications.at(-1)!.text, /timed out/);
      assert.equal(remoteCalls.includes(ENDPOINTS.tokenUrl), outcome === "success");
      const exposed = JSON.stringify({ notifications: host.notifications, markdown: host.markdownArgs, widgets: host.widgetCalls, exec: host.execCalls });
      assert.doesNotMatch(exposed, /www\.figma\.com\/oauth\/mcp|client_id|state=|code_challenge|test-access|test-refresh/);
      await assert.rejects(fetch(local.startUrl, { redirect: "manual" }));
    } finally { await host.shutdown(); await login; host.cleanup(); }
  });
}

test("a thrown browser error is a static notice and does not abort OAuth", async () => {
  const host = fixture(async options => {
    await options.onAuthorizationReady(entry);
    assert.equal(options.signal?.aborted, false);
    return grant;
  });
  host.api.exec = async () => { throw new Error("www.figma.com/oauth/mcp?client_id=secret&state=secret&code_challenge=secret"); };
  try {
    await host.run("login");
    assert.equal(host.credentials.size, 1);
    assert.ok(host.notifications.some(note => /authorization is still waiting/.test(note.text)));
    assert.doesNotMatch(JSON.stringify(host.notifications), /secret|client_id|code_challenge/);
  } finally { await host.shutdown(); host.cleanup(); }
});

test("pre-aborted contexts do not start OAuth or display auth UI", async () => {
  let calls = 0;
  const host = fixture(async () => { calls++; return grant; });
  const controller = new AbortController();
  controller.abort();
  host.ctx.signal = controller.signal;
  try {
    await host.run("login");
    assert.equal(calls, 0);
    assert.deepEqual(host.events, []);
    assert.equal(host.widgetCalls.length, 0);
    assert.equal(host.credentials.size, 0);
  } finally { await host.shutdown(); host.cleanup(); }
});

for (const stop of ["cancel", "shutdown", "signal"] as const) {
  test(`${stop} clears UI before abort and waits; late ready callbacks cannot resurrect it`, { timeout: 3000 }, async () => {
    const ready = deferred<FlowOptions>();
    const pending = deferred<OAuthGrant>();
    const controller = new AbortController();
    const host = fixture(async options => {
      await options.onAuthorizationReady(entry);
      options.signal!.addEventListener("abort", () => host.events.push("abort"), { once: true });
      ready.resolve(options);
      return pending.promise;
    });
    host.ctx.signal = controller.signal;
    const login = host.run("login");
    try {
      const options = await ready.promise;
      let stopped = false;
      const stopping = stop === "signal" ? (controller.abort(), Promise.resolve()) : Promise.resolve(stop === "cancel" ? host.run("cancel") : host.shutdown());
      const complete = stopping.then(() => { stopped = true; });
      assert.deepEqual(host.events.slice(-3), ["widget:clear", "status:clear", "abort"]);
      assert.equal(options.signal?.aborted, true);
      await options.onAuthorizationReady(entry);
      await options.onAuthorizationReady(entry);
      assert.equal(host.widgets.size, 0);
      assert.equal(host.execCalls.length, 1);
      if (stop !== "signal") assert.equal(stopped, false);
      pending.resolve(grant);
      await Promise.all([login, complete]);
      assert.equal(host.credentials.size, 0);
      assert.equal(host.events.filter(event => event === "widget:clear").length, 1);
    } finally { pending.resolve(grant); await login; await host.shutdown(); host.cleanup(); }
  });
}

test("throwing UI cleanup cannot strand cancellation or shutdown", { timeout: 3000 }, async () => {
  const ready = deferred<FlowOptions>();
  const host = fixture(async options => {
    await options.onAuthorizationReady(entry);
    ready.resolve(options);
    return new Promise<OAuthGrant>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new UserError("Figma authorization cancelled.")), { once: true }));
  });
  const login = host.run("login");
  try {
    await ready.promise;
    host.ctx.ui.setWidget = () => { throw new Error("disposed widget"); };
    host.ctx.ui.setStatus = () => { throw new Error("disposed status"); };
    host.ctx.ui.notify = () => { throw new Error("disposed notifications"); };
    await host.shutdown();
    await login;
    assert.equal(host.credentials.size, 0);
  } finally { await host.shutdown(); await login; host.cleanup(); }
});

test("reentrant UI cleanup preserves the active lock and cannot clear a later login", { timeout: 3000 }, async () => {
  const secondReady = deferred<void>();
  const secondResult = deferred<OAuthGrant>();
  let calls = 0;
  const host = fixture(async options => {
    calls++;
    await options.onAuthorizationReady(entry);
    if (calls === 1) return grant;
    secondReady.resolve();
    return secondResult.promise;
  });
  const setWidget = host.ctx.ui.setWidget!;
  let reentrant: Promise<void> | undefined;
  host.ctx.ui.setWidget = (key, factory, options) => {
    setWidget(key, factory, options);
    if (!factory && !reentrant) reentrant = host.run("login");
  };
  try {
    await host.run("login");
    await reentrant;
    assert.equal(calls, 1);
    assert.ok(host.notifications.some(note => /already running/.test(note.text)));
    const second = host.run("login");
    await secondReady.promise;
    assert.equal(host.widgets.size, 1);
    assert.equal(host.statuses.get(widgetKey), "Waiting for Figma authorization");
    assert.equal(host.events.at(-1), "exec");
    secondResult.resolve(grant);
    await second;
    assert.equal(host.widgets.size, 0);
  } finally { secondResult.resolve(grant); await host.shutdown(); host.cleanup(); }
});

for (const conflict of ["config", "profile", "credential"] as const) {
  test(`late ${conflict} changes prevent saving OAuth credentials`, async () => {
    const originalProfile = process.env.OMP_PROFILE;
    const host = fixture(async options => {
      await options.onAuthorizationReady(entry);
      if (conflict === "config") writeFileSync(join(host.dir, "mcp.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp", headers: { custom: "retain" } } } }));
      if (conflict === "profile") process.env.OMP_PROFILE = resolveActiveProfile() === "late-profile" ? "other-profile" : "late-profile";
      if (conflict === "credential") host.credentials.set(nativeCredentialIdFor(resolveActiveProfile()), {
        ...grant, type: "oauth", access: "foreign-access", figmaRemoteAuthOwner: "another-source",
        figmaRemoteAuthCredentialId: nativeCredentialIdFor(resolveActiveProfile()),
      });
      return grant;
    });
    try {
      await host.run("login");
      assert.equal([...host.credentials.values()].some(value => value.access === grant.access), false);
      assert.equal(host.notifications.at(-1)!.level, "error");
      assert.equal(host.widgets.size, 0);
      if (conflict === "config") assert.match(readFileSync(join(host.dir, "mcp.json"), "utf8"), /retain/);
      if (conflict === "credential") assert.equal([...host.credentials.values()][0].access, "foreign-access");
      if (conflict === "profile") assert.match(host.notifications.at(-1)!.text, /profile changed/);
    } finally {
      if (originalProfile === undefined) delete process.env.OMP_PROFILE;
      else process.env.OMP_PROFILE = originalProfile;
      await host.shutdown(); host.cleanup();
    }
  });
}
