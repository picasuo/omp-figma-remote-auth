import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIGMA_URL, formatError, parseArgs } from "../src/args.ts";
import { inspectLegacyConfig, removeLegacyConfig } from "../src/config.ts";
import { migrateLegacyData } from "../src/migration.ts";
import { ENDPOINTS } from "../src/oauth.ts";
import { OWNER, legacyCredentialIdFor, nativeCredentialIdFor, resolveActiveProfile, credentialStatus, logout, saveCredential } from "../src/storage.ts";
import type { AuthStorage, Credential } from "../src/storage.ts";

const grant = {
  access: "ACCESS-PRIVATE", refresh: "REFRESH-PRIVATE", expires: 1_800_000_000_000,
  clientId: "client", clientSecret: "SECRET-PRIVATE", tokenUrl: ENDPOINTS.tokenUrl,
  authorizationUrl: ENDPOINTS.authorizationUrl, scope: "mcp:connect",
};

function memoryStorage(): AuthStorage & { values: Map<string, unknown>; mutations: string[] } {
  const values = new Map<string, unknown>();
  const mutations: string[] = [];
  return {
    values, mutations, get: id => values.get(id),
    set: async (id, credential) => { mutations.push(`set:${id}`); values.set(id, credential); },
    remove: async id => { mutations.push(`remove:${id}`); values.delete(id); },
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omp-figma-migration-"));
  const legacyId = legacyCredentialIdFor(directory);
  const nativeId = nativeCredentialIdFor(undefined);
  const path = join(directory, "mcp.json");
  const storage = memoryStorage();
  const figma = { type: "http", url: FIGMA_URL, auth: { type: "oauth", credentialId: legacyId } };
  const legacy: Credential = { ...grant, type: "oauth", figmaRemoteAuthOwner: OWNER, figmaRemoteAuthCredentialId: legacyId };
  const original = { $schema: "https://example.com/schema", custom: { keep: true }, mcpServers: {
    other: { type: "stdio", command: "other", env: { TEST: "value" } }, figma,
  } };
  const raw = JSON.stringify(original);
  writeFileSync(path, raw, { mode: 0o644 });
  storage.values.set(legacyId, legacy);
  return {
    directory, path, legacyId, nativeId, storage, figma, legacy, original, raw,
    migrate: () => migrateLegacyData(directory, storage, undefined),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("arguments default to Codex/random port and reject unsupported inputs without echoing them", () => {
  assert.deepEqual(parseArgs("login"), { kind: "login", clientName: "Codex", port: 0, openBrowser: true });
  assert.deepEqual(parseArgs('login --client-name "My Client" --port 65535'), { kind: "login", clientName: "My Client", port: 65535, openBrowser: true });
  for (const args of ["--no-browser --port 123 --client-name Codex", "--port 123 --no-browser --client-name Codex", "--client-name Codex --port 123 --no-browser"]) {
    assert.deepEqual(parseArgs(`login ${args}`), { kind: "login", clientName: "Codex", port: 123, openBrowser: false });
  }
  assert.deepEqual(parseArgs(""), { kind: "help" });
  assert.deepEqual(parseArgs("cancel"), { kind: "cancel" });
  for (const args of [
    "login --url https://evil.example", "login --server other", "login --port -1", "login --port 1.5",
    "login --port 65536", "login --port", "login --port 2 --port 3", "status --port 0", "cancel extra",
    "login --client-name ''", 'login --client-name "unterminated', "login --unknown SECRET",
    "login --no-browser --no-browser", "login --no-browser true", "login --no-browser=false", "login --port --no-browser",
  ]) assert.throws(() => parseArgs(args));
  assert.equal(formatError(new Error("SECRET" )).includes("SECRET"), false);
});

test("profiles follow strict environment precedence, trim, default and native URL key rules", () => {
  for (const env of [{}, { PI_PROFILE: "default" }, { OMP_PROFILE: " default " },
    { OMP_PROFILE: "", PI_PROFILE: "work" }, { OMP_PROFILE: "  ", PI_PROFILE: "INVALID" }]) {
    assert.equal(resolveActiveProfile(env), undefined);
  }
  assert.equal(resolveActiveProfile({ OMP_PROFILE: undefined, PI_PROFILE: " work " }), "work");
  assert.equal(resolveActiveProfile({ OMP_PROFILE: " team-1.a_b ", PI_PROFILE: "INVALID" }), "team-1.a_b");
  assert.equal(resolveActiveProfile({ OMP_PROFILE: "a".repeat(64) }), "a".repeat(64));
  for (const profile of [".", "..", "a.", "Upper", "a b", "a/b", "a\\b", "a:b", "_name", "-name", "é", "a\nname", "a".repeat(65),
    "con", "prn", "aux", "nul", "con.txt", "prn.more.txt", "aux.x", "nul.x",
    ...Array.from({ length: 10 }, (_, i) => `com${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}.txt`)]) {
    assert.throws(() => resolveActiveProfile({ OMP_PROFILE: profile, PI_PROFILE: "valid" }), {
      message: "Invalid OMP profile name. Resolve the profile environment setting before retrying.",
    });
    assert.throws(() => resolveActiveProfile({ PI_PROFILE: profile }));
  }
  for (const profile of ["console", "com10", "lpt10", "con-name", "com1_name", "a..b"]) {
    assert.equal(resolveActiveProfile({ OMP_PROFILE: profile }), profile);
  }
  assert.equal(nativeCredentialIdFor(undefined), `mcp_oauth:profile:default:${FIGMA_URL}`);
  assert.equal(nativeCredentialIdFor("work"), `mcp_oauth:profile:work:${FIGMA_URL}`);
  assert.notEqual(nativeCredentialIdFor(undefined), nativeCredentialIdFor("work"));
  assert.equal(legacyCredentialIdFor("/profile/a"), `mcp_oauth_omp_figma_${createHash("sha256").update(`/profile/a\n${FIGMA_URL}`).digest("hex").slice(0, 24)}`);
  assert.notEqual(legacyCredentialIdFor("/profile/a"), legacyCredentialIdFor("/profile/b"));
});

test("absent legacy config causes zero writes, including no directory or lock creation", async t => {
  const root = mkdtempSync(join(tmpdir(), "omp-figma-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "missing", "profile");
  const id = legacyCredentialIdFor(directory);
  const storage = memoryStorage();
  assert.deepEqual(inspectLegacyConfig(directory, id), { kind: "absent", path: join(directory, "mcp.json") });
  assert.equal(removeLegacyConfig(directory, id), false);
  assert.deepEqual(await migrateLegacyData(directory, storage, undefined), { configRemoved: false, credentialMigrated: false });
  assert.equal(existsSync(join(root, "missing")), false);
  assert.deepEqual(storage.mutations, []);
  for (const raw of [undefined, "{}", '{ "$schema": "keep", "mcpServers": {} }', '{"mcpServers":{"other":{"command":"keep"}}}']) {
    const path = join(root, "mcp.json");
    if (raw !== undefined) writeFileSync(path, raw);
    const before = statSync(root);
    assert.equal(removeLegacyConfig(root, legacyCredentialIdFor(root)), false);
    assert.equal(statSync(root).mtimeMs, before.mtimeMs);
    assert.equal(statSync(root).ctimeMs, before.ctimeMs);
    assert.deepEqual(readdirSync(root), raw === undefined ? [] : ["mcp.json"]);
    if (raw !== undefined) assert.equal(readFileSync(path, "utf8"), raw);
  }
});

test("migration copies the full credential before config removal, updates metadata and preserves unrelated data", async t => {
  const f = fixture(); t.after(f.cleanup);
  const originalSet = f.storage.set;
  const originalRemove = f.storage.remove;
  f.storage.set = async (id, value) => {
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    assert.equal(f.storage.get(f.legacyId), f.legacy);
    await originalSet(id, value);
  };
  f.storage.remove = async id => {
    assert.equal(inspectLegacyConfig(f.directory, f.legacyId).kind, "absent");
    assert.equal((f.storage.get(f.nativeId) as Credential).access, grant.access);
    await originalRemove(id);
  };
  assert.equal(inspectLegacyConfig(f.directory, f.legacyId).kind, "owned");
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: true });
  assert.deepEqual(f.storage.get(f.nativeId), { ...f.legacy, figmaRemoteAuthCredentialId: f.nativeId });
  assert.equal(f.storage.get(f.legacyId), undefined);
  assert.deepEqual(f.storage.mutations, [`set:${f.nativeId}`, `remove:${f.legacyId}`]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
    $schema: f.original.$schema, custom: f.original.custom, mcpServers: { other: f.original.mcpServers.other },
  });
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.directory), ["mcp.json"]);
  const after = readFileSync(f.path, "utf8");
  f.storage.mutations.length = 0;
  assert.deepEqual(await f.migrate(), { configRemoved: false, credentialMigrated: false });
  assert.equal(readFileSync(f.path, "utf8"), after);
  assert.deepEqual(f.storage.mutations, []);
});

test("tokenless owned config is removable and preserves an empty mcpServers object and file", async t => {
  const f = fixture(); t.after(f.cleanup);
  f.storage.values.clear();
  writeFileSync(f.path, JSON.stringify({ mcpServers: { figma: f.figma } }));
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: false });
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { mcpServers: {} });
  assert.deepEqual(f.storage.mutations, []);
});

test("legacy credentials migrate without config and only for the current agent directory/profile", async t => {
  const f = fixture(); t.after(f.cleanup);
  rmSync(f.path);
  const otherLegacy = legacyCredentialIdFor(join(f.directory, "another"));
  const otherNative = nativeCredentialIdFor("another");
  const untouched = { ...f.legacy, access: "OTHER-PROFILE" };
  f.storage.values.set(otherLegacy, untouched);
  f.storage.values.set(otherNative, untouched);
  const workId = nativeCredentialIdFor("work");
  assert.deepEqual(await migrateLegacyData(f.directory, f.storage, "work"), { configRemoved: false, credentialMigrated: true });
  assert.equal(f.storage.get(f.nativeId), undefined);
  assert.equal((f.storage.get(workId) as Credential).figmaRemoteAuthCredentialId, workId);
  assert.equal(f.storage.get(otherLegacy), untouched);
  assert.equal(f.storage.get(otherNative), untouched);
  assert.deepEqual(readdirSync(f.directory), []);
});

test("an existing owned native credential wins without overwrite, even if the legacy grant is stale", async t => {
  const f = fixture(); t.after(f.cleanup);
  f.storage.values.set(f.legacyId, { ...f.legacy, refresh: "" });
  const native = { ...f.legacy, access: "NEWER", figmaRemoteAuthCredentialId: f.nativeId };
  f.storage.values.set(f.nativeId, native);
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: false });
  assert.equal(f.storage.get(f.nativeId), native);
  assert.deepEqual(f.storage.mutations, [`remove:${f.legacyId}`]);
});

test("every extra or missing legacy config field is a conflict with zero mutation", async t => {
  const f = fixture(); t.after(f.cleanup);
  const cases = [
    null, [], {}, { type: "http", url: FIGMA_URL }, { url: FIGMA_URL, auth: f.figma.auth },
    { type: "http", auth: f.figma.auth }, { ...f.figma, type: "sse" }, { ...f.figma, url: "https://foreign.example/SECRET" },
    { ...f.figma, auth: null }, { ...f.figma, auth: {} }, { ...f.figma, auth: { type: "oauth" } },
    { ...f.figma, auth: { credentialId: f.legacyId } }, { ...f.figma, auth: { type: "api_key", credentialId: f.legacyId } },
    { ...f.figma, auth: { type: "oauth", credentialId: "FOREIGN-SECRET" } },
    { ...f.figma, auth: { ...f.figma.auth, extra: "SECRET" } },
    ...["headers", "enabled", "timeout", "command", "args", "env", "oauth", "token", "custom"].map(key => ({ ...f.figma, [key]: "SECRET" })),
    { ...f.figma, headers: {} }, { ...f.figma, headers: { aUtHoRiZaTiOn: "SECRET" } },
  ];
  for (const figma of cases) {
    const raw = JSON.stringify({ mcpServers: { figma } });
    writeFileSync(f.path, raw);
    const before = statSync(f.directory);
    assert.equal(inspectLegacyConfig(f.directory, f.legacyId).kind, "conflict");
    assert.throws(() => removeLegacyConfig(f.directory, f.legacyId), error => {
      assert.ok((error as Error).message.includes(f.path));
      assert.ok(!(error as Error).message.includes("SECRET"));
      return true;
    });
    await assert.rejects(f.migrate(), error => {
      assert.ok((error as Error).message.includes(f.path));
      assert.ok(!(error as Error).message.includes("SECRET"));
      return true;
    });
    assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.equal(statSync(f.directory).ctimeMs, before.ctimeMs);
    assert.deepEqual(readdirSync(f.directory), ["mcp.json"]);
    assert.equal(f.storage.get(f.legacyId), f.legacy);
    assert.deepEqual(f.storage.mutations, []);
  }
});

test("foreign native or legacy credentials preflight with zero credential/config mutation", async t => {
  const f = fixture(); t.after(f.cleanup);
  for (const key of [f.nativeId, f.legacyId]) {
    for (const foreign of ["SECRET", [], {}, { ...f.legacy, figmaRemoteAuthOwner: "foreign" },
      { ...f.legacy, figmaRemoteAuthCredentialId: "another" }, { ...f.legacy, type: "api_key" }]) {
      f.storage.values.clear();
      f.storage.values.set(f.legacyId, f.legacy);
      f.storage.values.set(key, foreign);
      const before = statSync(f.directory);
      await assert.rejects(f.migrate(), /Resolve that source before retrying/u);
      assert.equal(f.storage.get(key), foreign);
      assert.equal(readFileSync(f.path, "utf8"), f.raw);
      assert.equal(statSync(f.directory).ctimeMs, before.ctimeMs);
      assert.deepEqual(f.storage.mutations, []);
      assert.deepEqual(readdirSync(f.directory), ["mcp.json"]);
    }
  }
});

test("invalid JSON, mcpServers shapes, file and directory symlinks fail without credential mutation", async t => {
  const f = fixture(); t.after(f.cleanup);
  for (const raw of ["{invalid", "null", "[]", '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":"SECRET"}']) {
    writeFileSync(f.path, raw);
    await assert.rejects(f.migrate());
    assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.deepEqual(f.storage.mutations, []);
  }
  const target = join(f.directory, "target.json");
  writeFileSync(target, f.raw);
  rmSync(f.path);
  symlinkSync(target, f.path);
  await assert.rejects(f.migrate(), /safely/u);
  assert.equal(readFileSync(target, "utf8"), f.raw);
  rmSync(f.path);
  symlinkSync(join(f.directory, "missing.json"), f.path);
  await assert.rejects(f.migrate(), /safely/u);
  assert.equal(existsSync(join(f.directory, "missing.json")), false);
  const directoryLink = join(f.directory, "link");
  symlinkSync(f.directory, directoryLink);
  await assert.rejects(migrateLegacyData(directoryLink, f.storage, undefined), /real directory/u);
  assert.deepEqual(f.storage.mutations, []);
});

test("credential copy failures preserve legacy data and retry after either pre-commit or post-commit failure", async t => {
  for (const committed of [false, true]) {
    const f = fixture(); t.after(f.cleanup);
    const set = f.storage.set;
    f.storage.set = async (id, value) => {
      if (committed) await set(id, value);
      throw new Error("injected copy failure");
    };
    await assert.rejects(f.migrate(), /injected copy failure/u);
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    assert.equal(f.storage.get(f.legacyId), f.legacy);
    assert.equal(!!f.storage.get(f.nativeId), committed);
    f.storage.set = set;
    assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: !committed });
    assert.equal(f.storage.get(f.legacyId), undefined);
    assert.ok(f.storage.get(f.nativeId));
  }
});

test("invalid owned legacy grant cannot be copied and leaves config and storage untouched", async t => {
  const f = fixture(); t.after(f.cleanup);
  f.storage.values.set(f.legacyId, { ...f.legacy, refresh: "" });
  await assert.rejects(f.migrate(), /Invalid Figma OAuth credential/u);
  assert.equal(readFileSync(f.path, "utf8"), f.raw);
  assert.deepEqual(f.storage.mutations, []);
});

test("a config writer lock retains old config/credential; copied native data makes retry recoverable", async t => {
  const f = fixture(); t.after(f.cleanup);
  const lock = join(f.directory, ".figma-remote-auth-config.lock");
  writeFileSync(lock, "other writer");
  await assert.rejects(f.migrate(), /locked/u);
  assert.equal(readFileSync(lock, "utf8"), "other writer");
  assert.equal(readFileSync(f.path, "utf8"), f.raw);
  assert.equal(f.storage.get(f.legacyId), f.legacy);
  assert.ok(f.storage.get(f.nativeId));
  rmSync(lock);
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: false });
});

test("a config conflict introduced while copying preserves both credentials and the conflicting file", async t => {
  const f = fixture(); t.after(f.cleanup);
  const raw = JSON.stringify({ mcpServers: { figma: { ...f.figma, timeout: 42 } } });
  const set = f.storage.set;
  f.storage.set = async (id, value) => { await set(id, value); writeFileSync(f.path, raw); };
  await assert.rejects(f.migrate(), /exact legacy entry/u);
  assert.equal(readFileSync(f.path, "utf8"), raw);
  assert.equal(f.storage.get(f.legacyId), f.legacy);
  assert.ok(f.storage.get(f.nativeId));
  assert.deepEqual(f.storage.mutations, [`set:${f.nativeId}`]);
  writeFileSync(f.path, f.raw);
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: false });
});

test("raw comparison refuses a concurrent file change after temp creation and cleans its lock/temp", async t => {
  const f = fixture(); t.after(f.cleanup);
  const originalWrite = fs.writeFileSync;
  const changed = JSON.stringify({ ...f.original, concurrent: "preserve" });
  const mock = t.mock.method(fs, "writeFileSync", (file, data, options) => {
    originalWrite(file, data, options);
    if (typeof file === "number") {
      assert.equal(fs.fstatSync(file).mode & 0o777, 0o600);
      originalWrite(f.path, changed);
    }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.migrate(), /changed during migration/u);
    assert.equal(readFileSync(f.path, "utf8"), changed);
    assert.equal(f.storage.get(f.legacyId), f.legacy);
    assert.ok(f.storage.get(f.nativeId));
    assert.deepEqual(readdirSync(f.directory), ["mcp.json"]);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await f.migrate(), { configRemoved: true, credentialMigrated: false });
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).concurrent, "preserve");
});

test("rename failure and directory fsync failure retain the old credential and allow retry", async t => {
  for (const operation of ["rename", "directory-fsync"]) {
    const f = fixture(); t.after(f.cleanup);
    const originalSync = fs.fsyncSync;
    const mocked = operation === "rename"
      ? t.mock.method(fs, "renameSync", () => { throw new Error("injected rename failure"); })
      : t.mock.method(fs, "fsyncSync", fd => {
        if (fs.fstatSync(fd).isDirectory()) throw new Error("injected fsync failure");
        originalSync(fd);
      });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.migrate(), /atomically/u);
      assert.equal(f.storage.get(f.legacyId), f.legacy);
      assert.ok(f.storage.get(f.nativeId));
      assert.equal(inspectLegacyConfig(f.directory, f.legacyId).kind, operation === "rename" ? "owned" : "absent");
      assert.deepEqual(readdirSync(f.directory), ["mcp.json"]);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(await f.migrate(), { configRemoved: operation === "rename", credentialMigrated: false });
    assert.equal(f.storage.get(f.legacyId), undefined);
  }
});

test("legacy deletion failure leaves native usable and retry only finishes cleanup", async t => {
  const f = fixture(); t.after(f.cleanup);
  const remove = f.storage.remove;
  f.storage.remove = async () => { throw new Error("injected delete failure"); };
  await assert.rejects(f.migrate(), /injected delete failure/u);
  assert.equal(inspectLegacyConfig(f.directory, f.legacyId).kind, "absent");
  assert.equal(f.storage.get(f.legacyId), f.legacy);
  assert.ok(f.storage.get(f.nativeId));
  const raw = readFileSync(f.path, "utf8");
  f.storage.remove = remove;
  assert.deepEqual(await f.migrate(), { configRemoved: false, credentialMigrated: false });
  assert.equal(readFileSync(f.path, "utf8"), raw);
  assert.equal(f.storage.get(f.legacyId), undefined);
});

test("credential changes during an awaited copy are detected before any config or legacy deletion", async t => {
  for (const change of ["legacy-owned", "legacy-foreign", "native-foreign", "native-absent"]) {
    const f = fixture(); t.after(f.cleanup);
    const set = f.storage.set;
    f.storage.set = async (id, value) => {
      await set(id, value);
      if (change === "legacy-owned") f.storage.values.set(f.legacyId, { ...f.legacy, access: "ROTATED" });
      if (change === "legacy-foreign") f.storage.values.set(f.legacyId, { type: "api_key", key: "FOREIGN" });
      if (change === "native-foreign") f.storage.values.set(f.nativeId, { type: "api_key", key: "FOREIGN" });
      if (change === "native-absent") f.storage.values.delete(f.nativeId);
    };
    await assert.rejects(f.migrate());
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
    assert.ok(f.storage.get(f.legacyId));
    assert.deepEqual(f.storage.mutations, [`set:${f.nativeId}`]);
  }
});

test("overlapping migrations for either the same directory or native profile fail before mutation", async t => {
  const f = fixture(); t.after(f.cleanup);
  const other = fixture(); t.after(other.cleanup);
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const set = f.storage.set;
  f.storage.set = async (id, value) => { started(); await gate; await set(id, value); };
  const first = f.migrate();
  try {
    await ready;
    await assert.rejects(f.migrate(), /already running/u);
    await assert.rejects(migrateLegacyData(f.directory, f.storage, "work"), /already running/u);
    await assert.rejects(other.migrate(), /already running/u);
    assert.deepEqual(f.storage.mutations, []);
    assert.deepEqual(other.storage.mutations, []);
    assert.equal(readFileSync(f.path, "utf8"), f.raw);
  } finally { release(); await first; }
  assert.deepEqual(await other.migrate(), { configRemoved: true, credentialMigrated: true });
});

test("credentials preserve native refresh fields and ownership and never expose secrets in status", async () => {
  const storage = memoryStorage();
  const id = nativeCredentialIdFor("work");
  await saveCredential(storage, id, grant);
  const saved = storage.get(id) as Credential;
  assert.deepEqual(saved, { ...grant, type: "oauth", figmaRemoteAuthOwner: OWNER, figmaRemoteAuthCredentialId: id });
  storage.values.set(id, { ...saved, access: "ROTATED-PRIVATE", refresh: "ROTATED-REFRESH" });
  const status = credentialStatus(storage, id, 1_700_000_000_000);
  assert.match(status, /present; access token expires/u);
  for (const secret of [grant.access, grant.refresh, grant.clientSecret, "ROTATED-PRIVATE", "ROTATED-REFRESH"]) {
    assert.equal(status.includes(secret), false);
  }
  assert.match(credentialStatus(storage, id, 1_900_000_000_000), /access token expired/u);
  storage.values.set(id, { ...saved, expires: NaN });
  assert.match(credentialStatus(storage, id), /expiration metadata is invalid/u);
  const foreign = { type: "oauth", access: "FOREIGN" };
  storage.values.set(id, foreign);
  assert.equal(credentialStatus(storage, id), "Credential: managed by another authentication source.");
  await assert.rejects(saveCredential(storage, id, grant), /Resolve that source before retrying/u);
  assert.equal(storage.get(id), foreign);
  storage.values.delete(id);
  assert.equal(credentialStatus(storage, id), "Credential: not logged in.");
  storage.mutations.length = 0;
  for (const invalid of [{ ...grant, refresh: "" }, { ...grant, access: "" }, { ...grant, clientId: "" },
    { ...grant, expires: 0 }, { ...grant, expires: Infinity }, { ...grant, expires: 1.5 },
    { ...grant, tokenUrl: "https://foreign.example" }, { ...grant, authorizationUrl: "https://foreign.example" }]) {
    await assert.rejects(saveCredential(storage, id, invalid), /Invalid Figma OAuth credential/u);
  }
  assert.deepEqual(storage.mutations, []);
});

test("dual-key logout checks both keys first and removes only owned credentials", async () => {
  for (const nativeOwned of [false, true]) {
    for (const legacyOwned of [false, true]) {
      const storage = memoryStorage();
      const nativeId = nativeCredentialIdFor("work");
      const legacyId = legacyCredentialIdFor("/active/agent");
      const foreign = { type: "oauth", access: "FOREIGN" };
      const credential = (id: string): Credential => ({ ...grant, type: "oauth", figmaRemoteAuthOwner: OWNER, figmaRemoteAuthCredentialId: id });
      storage.values.set(nativeId, nativeOwned ? credential(nativeId) : foreign);
      storage.values.set(legacyId, legacyOwned ? credential(legacyId) : foreign);
      storage.values.set("unrelated", foreign);
      const reads: string[] = [];
      const get = storage.get;
      storage.get = id => { reads.push(id); return get(id); };
      const remove = storage.remove;
      storage.remove = async id => {
        assert.ok(reads.includes(nativeId)); assert.ok(reads.includes(legacyId));
        await remove(id);
      };
      assert.equal(await logout(storage, nativeId, legacyId), nativeOwned || legacyOwned);
      assert.equal(storage.get(nativeId), nativeOwned ? undefined : foreign);
      assert.equal(storage.get(legacyId), legacyOwned ? undefined : foreign);
      assert.equal(storage.get("unrelated"), foreign);
      assert.equal(await logout(storage, nativeId, legacyId), false);
    }
  }
});

test("logout rechecks ownership after the first asynchronous deletion", async t => {
  const f = fixture(); t.after(f.cleanup);
  await saveCredential(f.storage, f.nativeId, grant);
  const foreign = { type: "api_key", key: "FOREIGN" };
  const remove = f.storage.remove;
  f.storage.remove = async id => { await remove(id); f.storage.values.set(f.legacyId, foreign); };
  assert.equal(await logout(f.storage, f.nativeId, f.legacyId), true);
  assert.equal(f.storage.get(f.legacyId), foreign);
  assert.equal(readFileSync(f.path, "utf8"), f.raw);
});
