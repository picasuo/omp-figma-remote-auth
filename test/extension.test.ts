import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerExtension } from "../index.ts";
import type { CommandContext, Dependencies, ExtensionAPI } from "../index.ts";
import { ENDPOINTS } from "../src/oauth.ts";
import type { FlowOptions, OAuthGrant } from "../src/oauth.ts";
import { credentialIdFor } from "../src/storage.ts";
import type { Credential } from "../src/storage.ts";

const grant: OAuthGrant = {
  clientId: "test-client", clientSecret: "test-secret",
  access: "test-access", refresh: "test-refresh", expires: 4_000_000_000_000,
  tokenUrl: ENDPOINTS.tokenUrl, authorizationUrl: ENDPOINTS.authorizationUrl,
};

function fixture(runOAuth: NonNullable<Dependencies["runOAuth"]>) {
  const dir = mkdtempSync(join(tmpdir(), "figma-extension-"));
  const credentials = new Map<string, Credential>();
  const notifications: Array<{ text: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  let commandName = "";
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let shutdown!: () => void | Promise<void>;
  const ctx: CommandContext = {
    modelRegistry: { authStorage: {
      get: id => credentials.get(id),
      set: async (id, value) => { credentials.set(id, value); },
      remove: async id => { credentials.delete(id); },
    } },
    ui: {
      notify: (text, level) => { notifications.push({ text, level }); },
      setStatus: (key, value) => { statuses.set(key, value); },
    },
  };
  registerExtension({
    pi: { getAgentDir: () => dir },
    registerCommand(name, value) { commandName = name; command = value; },
    on(event, handler) { assert.equal(event, "session_shutdown"); shutdown = handler; },
  }, { runOAuth });
  return {
    dir, credentials, notifications, statuses, commandName,
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
test("registered commands configure, authorize, report status and remove native credentials", async () => {
  let options: FlowOptions | undefined;
  const host = fixture(async value => {
    options = value;
    await value.onAuthorizationUrl("https://www.figma.com/oauth/mcp?test=1", "http://127.0.0.1:1234/callback");
    return grant;
  });
  try {
    assert.equal(host.commandName, "figma-remote-auth");
    await host.run("help");
    assert.match(host.notifications.at(-1)!.text, /figma-remote-auth login/);
    await host.run("setup");
    const config = JSON.parse(readFileSync(join(host.dir, "mcp.json"), "utf8"));
    assert.equal(config.mcpServers.figma.auth.credentialId, credentialIdFor(host.dir));
    await host.run("login --port 0");
    assert.equal(options?.clientName, "Codex");
    assert.equal(options?.port, 0);
    const saved = host.credentials.get(credentialIdFor(host.dir));
    assert.equal(saved?.access, grant.access);
    assert.equal(saved?.refresh, grant.refresh);
    assert.equal(saved?.clientSecret, grant.clientSecret);
    assert.equal(saved?.type, "oauth");
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
    await host.run("setup");
    assert.match(host.notifications.at(-1)!.text, /shutting down/);
  } finally {
    pending.resolve(grant);
    await login;
    await host.shutdown();
    host.cleanup();
  }
});
