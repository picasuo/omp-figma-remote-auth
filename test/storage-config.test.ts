import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIGMA_URL, formatError, parseArgs } from "../src/args.ts";
import { configStatus, mergeConfig, setupConfig } from "../src/config.ts";
import { ENDPOINTS } from "../src/oauth.ts";
import { credentialIdFor, credentialStatus, logout, saveCredential } from "../src/storage.ts";
import type { AuthStorage, Credential } from "../src/storage.ts";

const grant = {
  access: "ACCESS-PRIVATE", refresh: "REFRESH-PRIVATE", expires: 1_800_000_000_000,
  clientId: "client", clientSecret: "SECRET-PRIVATE", tokenUrl: ENDPOINTS.tokenUrl,
  authorizationUrl: ENDPOINTS.authorizationUrl, scope: "mcp:connect",
};

function memoryStorage(): AuthStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values, get: id => values.get(id),
    set: async (id, credential) => { values.set(id, credential); },
    remove: async id => { values.delete(id); },
  };
}

test("arguments default to Codex/random port and reject unsupported inputs without echoing them", () => {
  assert.deepEqual(parseArgs("login"), { kind: "login", clientName: "Codex", port: 0 });
  assert.deepEqual(parseArgs('login --client-name "My Client" --port 65535'), { kind: "login", clientName: "My Client", port: 65535 });
  assert.deepEqual(parseArgs(""), { kind: "help" });
  assert.deepEqual(parseArgs("cancel"), { kind: "cancel" });
  for (const args of [
    "login --url https://evil.example", "login --server other", "login --port -1", "login --port 1.5",
    "login --port 65536", "login --port", "login --port 2 --port 3", "status --port 0", "cancel extra",
    "login --client-name ''", 'login --client-name "unterminated', "login --unknown SECRET",
  ]) assert.throws(() => parseArgs(args));
  assert.equal(formatError(new Error("SECRET" )).includes("SECRET"), false);
});

test("setup preserves schema, unrelated servers, extra fields and existing harmless headers", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-figma-config-"));
  try {
    const id = credentialIdFor(directory);
    const original = {
      $schema: "https://example.com/schema", custom: { keep: true },
      mcpServers: {
        other: { type: "stdio", command: "other", env: { TEST: "value" } },
        figma: { type: "http", url: FIGMA_URL, timeout: 123, headers: { "X-Custom": "keep" } },
      },
    };
    writeFileSync(join(directory, "mcp.json"), JSON.stringify(original), { mode: 0o644 });
    assert.equal(configStatus(directory, id).configured, false);
    setupConfig(directory, id);
    const actual = JSON.parse(readFileSync(join(directory, "mcp.json"), "utf8"));
    assert.equal(actual.$schema, original.$schema);
    assert.deepEqual(actual.custom, original.custom);
    assert.deepEqual(actual.mcpServers.other, original.mcpServers.other);
    assert.deepEqual(actual.mcpServers.figma, { ...original.mcpServers.figma, auth: { type: "oauth", credentialId: id } });
    assert.equal(statSync(join(directory, "mcp.json")).mode & 0o777, 0o600);
    assert.equal(configStatus(directory, id).configured, true);
    const before = readFileSync(join(directory, "mcp.json"), "utf8");
    setupConfig(directory, id);
    assert.equal(readFileSync(join(directory, "mcp.json"), "utf8"), before);
    assert.deepEqual(readdirSync(directory), ["mcp.json"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("setup creates private directories and config", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-figma-new-"));
  const directory = join(root, "profile");
  try {
    setupConfig(directory, credentialIdFor(directory));
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "mcp.json")).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("conflicts do not overwrite config; errors do not reveal existing credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-figma-conflict-"));
  const id = credentialIdFor(directory);
  try {
    for (const figma of [
      { type: "http", url: "https://other.example" },
      { type: "sse", url: FIGMA_URL },
      { type: "http", url: FIGMA_URL, headers: { aUtHoRiZaTiOn: "SECRET" } },
      { type: "http", url: FIGMA_URL, auth: { type: "oauth", credentialId: "foreign" } },
      { type: "http", url: FIGMA_URL, auth: { type: "api_key", key: "SECRET" } },
      { type: "http", url: FIGMA_URL, auth: { type: "oauth", credentialId: id, clientSecret: "SECRET" } },
      { type: "http", url: FIGMA_URL, command: "other" }, null,
    ]) {
      const raw = JSON.stringify({ mcpServers: { figma } });
      writeFileSync(join(directory, "mcp.json"), raw);
      assert.throws(() => setupConfig(directory, id), error => {
        assert.equal((error as Error).message.includes("SECRET"), false);
        return true;
      });
      assert.equal(readFileSync(join(directory, "mcp.json"), "utf8"), raw);
      assert.equal(existsSync(join(directory, ".figma-remote-auth-config.lock")), false);
    }
    assert.throws(() => mergeConfig({ mcpServers: [] }, id));
    writeFileSync(join(directory, "mcp.json"), "{invalid");
    assert.throws(() => setupConfig(directory, id), /valid JSON/u);
    assert.equal(readFileSync(join(directory, "mcp.json"), "utf8"), "{invalid");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("config symlinks and concurrent writer locks are refused without touching targets", () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-figma-links-"));
  const target = join(directory, "target.json");
  try {
    writeFileSync(target, "{}");
    symlinkSync(target, join(directory, "mcp.json"));
    assert.throws(() => setupConfig(directory, credentialIdFor(directory)), /safely/u);
    assert.equal(readFileSync(target, "utf8"), "{}");
    rmSync(join(directory, "mcp.json"));
    writeFileSync(join(directory, ".figma-remote-auth-config.lock"), "locked");
    assert.throws(() => setupConfig(directory, credentialIdFor(directory)), /locked/u);
    assert.equal(readFileSync(join(directory, ".figma-remote-auth-config.lock"), "utf8"), "locked");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("credentials map to native OMP refresh fields, isolate profiles and redact status", async () => {
  const storage = memoryStorage();
  const id = credentialIdFor("/profile/a");
  assert.equal(id, `mcp_oauth_omp_figma_${createHash("sha256").update(`/profile/a\n${FIGMA_URL}`).digest("hex").slice(0, 24)}`);
  assert.notEqual(id, credentialIdFor("/profile/b"));
  storage.values.set("other", { type: "api_key", key: "OTHER" });
  await saveCredential(storage, id, grant);
  const saved = storage.get(id) as Credential;
  assert.equal(saved.type, "oauth");
  for (const field of ["access", "refresh", "expires", "clientId", "clientSecret", "tokenUrl", "authorizationUrl"] as const) {
    assert.equal(saved[field], grant[field]);
  }
  // OMP refresh spreads original metadata; plugin ownership must survive token rotation.
  storage.values.set(id, { ...saved, access: "ROTATED-PRIVATE", refresh: "ROTATED-REFRESH" });
  const status = credentialStatus(storage, id, 1_700_000_000_000);
  assert.match(status, /present/u);
  for (const secret of [grant.access, grant.refresh, grant.clientSecret, "ROTATED-PRIVATE", "ROTATED-REFRESH"]) {
    assert.equal(status.includes(secret), false);
  }
  assert.equal(await logout(storage, id), true);
  assert.equal(await logout(storage, id), false);
  assert.deepEqual(storage.get("other"), { type: "api_key", key: "OTHER" });
});

test("foreign credentials cannot be replaced or removed, invalid grants never persist", async () => {
  const storage = memoryStorage();
  const id = credentialIdFor("/profile/a");
  const foreign = { type: "oauth", access: "FOREIGN" };
  storage.values.set(id, foreign);
  await assert.rejects(saveCredential(storage, id, grant), /another authentication source/u);
  await assert.rejects(logout(storage, id), /another authentication source/u);
  assert.equal(storage.get(id), foreign);
  storage.values.delete(id);
  await assert.rejects(saveCredential(storage, id, { ...grant, refresh: "" }));
  assert.equal(storage.get(id), undefined);
});
