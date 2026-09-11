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
export function credentialIdFor(agentDir: string): string {
  return `mcp_oauth_omp_figma_${createHash("sha256").update(`${agentDir}\n${FIGMA_URL}`).digest("hex").slice(0, 24)}`;
}
export function ownedCredential(storage: AuthStorage, credentialId: string): Credential | undefined {
  const value = storage.get(credentialId);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) ||
      (value as Partial<Credential>).type !== "oauth" ||
      (value as Partial<Credential>).figmaRemoteAuthOwner !== OWNER ||
      (value as Partial<Credential>).figmaRemoteAuthCredentialId !== credentialId) {
    throw new UserError("The Figma credential ID is occupied by another authentication source. It was not changed.");
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
export async function logout(storage: AuthStorage, credentialId: string): Promise<boolean> {
  if (!ownedCredential(storage, credentialId)) return false;
  await storage.remove(credentialId);
  return true;
}
export function credentialStatus(storage: AuthStorage, credentialId: string, now = Date.now()): string {
  const credential = ownedCredential(storage, credentialId);
  if (!credential) return "Credential: not logged in.";
  const expiry = credential.expires;
  if (!Number.isSafeInteger(expiry) || expiry <= 0 || expiry > 8.64e15) {
    return "Credential: present, but expiration metadata is invalid; log in again.";
  }
  return `Credential: present; ${expiry > now ? "access token expires" : "access token expired"} ${new Date(expiry).toISOString()}. OMP handles refresh.`;
}
