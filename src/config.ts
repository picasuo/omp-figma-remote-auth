import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FIGMA_URL, UserError } from "./args.ts";

type JsonObject = Record<string, unknown>;
function record(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export interface ConfigState { configured: boolean; path: string }

/** Newly created private directories use 0700; normal ancestor links (macOS /tmp) are allowed. */
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new UserError("OMP config directory must be a real directory, not a symlink.");
  }
}
function readConfig(path: string): { raw?: string; config: JsonObject } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const raw = readFileSync(fd, "utf8");
    let config: unknown;
    try { config = JSON.parse(raw); }
    catch { throw new UserError("OMP mcp.json must contain valid JSON; it was not changed."); }
    if (!record(config)) throw new UserError("OMP mcp.json must contain a JSON object.");
    return { raw, config };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    if (error instanceof UserError) throw error;
    throw new UserError("Unable to read OMP mcp.json safely; it was not changed.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Validate before mutation, preserving all unrelated JSON fields and servers. */
export function mergeConfig(config: JsonObject, credentialId: string): JsonObject {
  const servers = config.mcpServers;
  if (servers !== undefined && !record(servers)) {
    throw new UserError("mcpServers must be an object; mcp.json was not changed.");
  }
  const entries = servers ?? {};
  const existing = entries.figma;
  if (Object.hasOwn(entries, "figma")) {
    if (!record(existing) || existing.url !== FIGMA_URL || existing.type !== "http") {
      throw new UserError("Existing figma endpoint/type conflicts with official Figma HTTP MCP; mcp.json was not changed.");
    }
    if (existing.headers !== undefined) {
      if (!record(existing.headers) || Object.keys(existing.headers).some(key => key.toLowerCase() === "authorization")) {
        throw new UserError("Existing figma headers conflict with OAuth; mcp.json was not changed.");
      }
    }
    if (Object.hasOwn(existing, "auth")) {
      const auth = existing.auth;
      if (!record(auth) || auth.type !== "oauth" || auth.credentialId !== credentialId ||
          Object.keys(auth).some(key => !["type", "credentialId"].includes(key))) {
        throw new UserError("Existing figma auth belongs to another source or has conflicting options; mcp.json was not changed.");
      }
    }
    // Do not silently combine a URL transport with alternate endpoint/credential settings.
    if (["endpoint", "command", "args", "env", "apiKey", "token", "bearerToken", "oauth"].some(key => Object.hasOwn(existing, key))) {
      throw new UserError("Existing figma transport or credential options conflict; mcp.json was not changed.");
    }
  }
  return {
    ...config,
    mcpServers: {
      ...entries,
      figma: { ...(record(existing) ? existing : {}), type: "http", url: FIGMA_URL, auth: { type: "oauth", credentialId } },
    },
  };
}

export function configStatus(agentDir: string, credentialId: string): ConfigState {
  const path = join(agentDir, "mcp.json");
  const { config } = readConfig(path);
  mergeConfig(config, credentialId); // Status reports conflicts without revealing values.
  const servers = record(config.mcpServers) ? config.mcpServers : {};
  const figma = record(servers.figma) ? servers.figma : {};
  const auth = record(figma.auth) ? figma.auth : {};
  return { configured: auth.credentialId === credentialId, path };
}

/** Synchronous lock/read/merge/rename keeps local operations in one uninterrupted turn. */
export function setupConfig(agentDir: string, credentialId: string): string {
  privateDirectory(agentDir);
  const path = join(agentDir, "mcp.json");
  const lockPath = join(agentDir, ".figma-remote-auth-config.lock");
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new UserError("Figma config is locked by another operation. If OMP crashed, remove .figma-remote-auth-config.lock after verifying no login is active."); }
  let temporary: string | undefined;
  let file: number | undefined;
  try {
    const { raw, config } = readConfig(path);
    const merged = mergeConfig(config, credentialId);
    if (JSON.stringify(config) === JSON.stringify(merged)) return path;
    temporary = join(agentDir, `.mcp.json.${randomBytes(16).toString("hex")}.tmp`);
    file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    if (readConfig(path).raw !== raw) throw new UserError("mcp.json changed during setup; retry the command.");
    renameSync(temporary, path);
    temporary = undefined;
    const directory = openSync(agentDir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return path;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("Unable to write OMP mcp.json atomically.");
  } finally {
    if (file !== undefined) closeSync(file);
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
