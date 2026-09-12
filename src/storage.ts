import { createHash } from "node:crypto";
import { FIGMA_URL, UserError } from "./args.ts";
import { ENDPOINTS } from "./oauth.ts";
import type { OAuthGrant } from "./oauth.ts";

export const OWNER = "omp-figma-remote-auth/v1";
export interface Credential extends OAuthGrant {
  type: "oauth";
  figmaRemoteAuthOwner: string;
  figmaRemoteAuthCredentialId: string;
}
/** The public AuthStorage contract exposed through ctx.modelRegistry.authStorage. */
export interface AuthStorage {
  get(provider: string): unknown;
  set(provider: string, credential: Credential): Promise<void>;
  remove(provider: string): Promise<void>;
}
export function legacyCredentialIdFor(agentDir: string): string {
  return `mcp_oauth_omp_figma_${createHash("sha256").update(`${agentDir}\n${FIGMA_URL}`).digest("hex").slice(0, 24)}`;
}
export function nativeCredentialIdFor(profile: string | undefined): string {
  return `mcp_oauth:profile:${profile ?? "default"}:${FIGMA_URL}`;
}
export function resolveActiveProfile(env: Record<string, string | undefined> = process.env): string | undefined {
  const profile = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (!profile || profile === "default") return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile) || profile.endsWith(".") ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/u.test(profile)) {
    throw new UserError("Invalid OMP profile name. Resolve the profile environment setting before retrying.");
  }
  return profile;
}
function isOwnedCredential(value: unknown, credentialId: string): value is Credential {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Partial<Credential>).type === "oauth" &&
    (value as Partial<Credential>).figmaRemoteAuthOwner === OWNER &&
    (value as Partial<Credential>).figmaRemoteAuthCredentialId === credentialId;
}
export function ownedCredential(storage: AuthStorage, credentialId: string): Credential | undefined {
  const value = storage.get(credentialId);
  if (value === undefined || value === null) return undefined;
  if (!isOwnedCredential(value, credentialId)) {
    throw new UserError("The Figma credential ID is occupied by another authentication source. Resolve that source before retrying; it was not changed.");
  }
  return value as Credential;
}
export async function saveCredential(storage: AuthStorage, credentialId: string, grant: OAuthGrant): Promise<void> {
  ownedCredential(storage, credentialId);
  // Defense in depth at the persistence boundary, even for callers other than the OAuth runner.
  if (!grant.access || !grant.refresh || !grant.clientId ||
      !Number.isSafeInteger(grant.expires) || grant.expires <= 0 || grant.expires > 8.64e15 ||
      grant.tokenUrl !== ENDPOINTS.tokenUrl || grant.authorizationUrl !== ENDPOINTS.authorizationUrl) {
    throw new UserError("Invalid Figma OAuth credential; nothing was saved.");
  }
  await storage.set(credentialId, {
    ...grant, type: "oauth", figmaRemoteAuthOwner: OWNER, figmaRemoteAuthCredentialId: credentialId,
  });
}
export async function logout(storage: AuthStorage, nativeId: string, legacyId: string): Promise<boolean> {
  // Inspect both keys before the first deletion, then recheck after any asynchronous removal.
  const ids = [...new Set([nativeId, legacyId])].filter(id => isOwnedCredential(storage.get(id), id));
  let removed = false;
  for (const id of ids) {
    if (!isOwnedCredential(storage.get(id), id)) continue;
    await storage.remove(id);
    removed = true;
  }
  return removed;
}
export function credentialStatus(storage: AuthStorage, credentialId: string, now = Date.now()): string {
  const credential = storage.get(credentialId);
  if (credential === undefined || credential === null) return "Credential: not logged in.";
  if (!isOwnedCredential(credential, credentialId)) return "Credential: managed by another authentication source.";
  const expiry = credential.expires;
  if (!Number.isSafeInteger(expiry) || expiry <= 0 || expiry > 8.64e15) {
    return "Credential: present, but expiration metadata is invalid; log in again.";
  }
  return `Credential: present; ${expiry > now ? "access token expires" : "access token expired"} ${new Date(expiry).toISOString()}. OMP handles refresh.`;
}
