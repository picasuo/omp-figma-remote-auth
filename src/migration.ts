import { resolve } from "node:path";
import { UserError } from "./args.ts";
import { inspectLegacyConfig, removeLegacyConfig } from "./config.ts";
import { legacyCredentialIdFor, nativeCredentialIdFor, ownedCredential, saveCredential } from "./storage.ts";
import type { AuthStorage } from "./storage.ts";

// AuthStorage has no compare-and-swap API. Prevent overlapping migrations in this process,
// including different agent directories that target the same native profile credential.
const migrating = new Set<string>();
export async function migrateLegacyData(
  agentDir: string, storage: AuthStorage, profile: string | undefined,
): Promise<{ configRemoved: boolean; credentialMigrated: boolean }> {
  const legacyId = legacyCredentialIdFor(agentDir);
  const nativeId = nativeCredentialIdFor(profile);
  const directoryKey = `directory:${resolve(agentDir)}`;
  if (migrating.has(directoryKey) || migrating.has(nativeId)) {
    throw new UserError("A Figma migration is already running. Retry after it finishes.");
  }
  migrating.add(directoryKey);
  migrating.add(nativeId);
  try {
    // Complete the read-only preflight before copying or removing anything.
    const config = inspectLegacyConfig(agentDir, legacyId);
    const legacy = ownedCredential(storage, legacyId);
    const native = ownedCredential(storage, nativeId);
    if (config.kind === "conflict") {
      throw new UserError(`Existing figma configuration in ${config.path} is not the exact legacy entry owned by this plugin. Resolve that configuration before retrying; nothing was migrated.`);
    }
    const legacySnapshot = legacy && JSON.stringify(legacy);
    let credentialMigrated = false;
    if (legacy && !native) {
      await saveCredential(storage, nativeId, { ...legacy });
      credentialMigrated = true;
    }
    // Saving can yield to another writer. Refuse newly foreign or changed legacy data,
    // and never remove the old path unless an owned native credential now exists.
    const currentLegacy = ownedCredential(storage, legacyId);
    const currentNative = ownedCredential(storage, nativeId);
    if ((currentLegacy && JSON.stringify(currentLegacy)) !== legacySnapshot || (legacy && !currentNative)) {
      throw new UserError("Figma credentials changed during migration; retry the command. The legacy data was retained.");
    }
    // This re-reads under the config lock and refuses any newly conflicting entry.
    // A successful copy can safely survive a removal failure for a subsequent retry.
    const configRemoved = removeLegacyConfig(agentDir, legacyId);
    if (legacy) await storage.remove(legacyId);
    return { configRemoved, credentialMigrated };
  } finally {
    migrating.delete(directoryKey);
    migrating.delete(nativeId);
  }
}
