import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FIGMA_URL, UserError } from "./args.ts";

type JsonObject = Record<string, unknown>;
function record(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export interface LegacyConfigState { kind: "absent" | "owned" | "conflict"; path: string }

/** Do not create anything; normal ancestor links (macOS /tmp) are allowed. */
function checkDirectory(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new UserError("OMP config directory must be a real directory, not a symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof UserError) throw error;
    throw new UserError("Unable to inspect the OMP config directory safely; it was not changed.");
  }
}
function readConfig(path: string): { raw?: string; config: JsonObject } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new UserError("OMP mcp.json must be a regular file; it was not changed.");
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

function classify(config: JsonObject, legacyId: string): LegacyConfigState["kind"] {
  if (!Object.hasOwn(config, "mcpServers")) return "absent";
  const servers = config.mcpServers;
  if (!record(servers)) throw new UserError("mcpServers must be an object; mcp.json was not changed.");
  if (!Object.hasOwn(servers, "figma")) return "absent";
  const figma = servers.figma;
  if (!record(figma) || Object.keys(figma).length !== 3 ||
      !Object.hasOwn(figma, "type") || figma.type !== "http" ||
      !Object.hasOwn(figma, "url") || figma.url !== FIGMA_URL ||
      !Object.hasOwn(figma, "auth") || !record(figma.auth)) return "conflict";
  const auth = figma.auth;
  return Object.keys(auth).length === 2 && Object.hasOwn(auth, "type") && auth.type === "oauth" &&
    Object.hasOwn(auth, "credentialId") && auth.credentialId === legacyId ? "owned" : "conflict";
}
function requireRemovable(kind: LegacyConfigState["kind"], path: string): void {
  if (kind === "conflict") {
    throw new UserError(`Existing figma configuration in ${path} is not the exact legacy entry owned by this plugin. Resolve that configuration before retrying; it was not changed.`);
  }
}
export function inspectLegacyConfig(agentDir: string, legacyId: string): LegacyConfigState {
  checkDirectory(agentDir);
  const path = join(agentDir, "mcp.json");
  return { kind: classify(readConfig(path).config, legacyId), path };
}

/** Only delete the exact owned legacy entry, preserving the file and every unrelated field. */
export function removeLegacyConfig(agentDir: string, legacyId: string): boolean {
  const state = inspectLegacyConfig(agentDir, legacyId);
  requireRemovable(state.kind, state.path);
  if (state.kind === "absent") return false; // No lock, directory, or file writes when absent.
  const path = state.path;
  const lockPath = join(agentDir, ".figma-remote-auth-config.lock");
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { throw new UserError("Figma config is locked by another operation. If OMP crashed, remove .figma-remote-auth-config.lock after verifying no login is active."); }
  let temporary: string | undefined;
  let file: number | undefined;
  try {
    checkDirectory(agentDir);
    const { raw, config } = readConfig(path);
    const kind = classify(config, legacyId);
    requireRemovable(kind, path);
    if (kind === "absent") return false;
    const servers = { ...(config.mcpServers as JsonObject) };
    delete servers.figma;
    const remaining = { ...config, mcpServers: servers };
    const candidate = join(agentDir, `.mcp.json.${randomBytes(16).toString("hex")}.tmp`);
    file = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporary = candidate;
    writeFileSync(file, `${JSON.stringify(remaining, null, 2)}\n`, "utf8");
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    if (readConfig(path).raw !== raw) throw new UserError("mcp.json changed during migration; retry the command.");
    renameSync(temporary, path);
    temporary = undefined;
    const directory = openSync(agentDir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return true;
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError("Unable to remove the legacy Figma configuration atomically; retry the command.");
  } finally {
    if (file !== undefined) closeSync(file);
    try {
      if (temporary !== undefined) unlinkSync(temporary);
    } finally {
      try { closeSync(lock); } finally { unlinkSync(lockPath); }
    }
  }
}
