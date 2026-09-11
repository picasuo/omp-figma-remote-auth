import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { UserError } from "./args.ts";

export const DISCOVERY_URL = "https://mcp.figma.com/.well-known/oauth-authorization-server";
export const ENDPOINTS = Object.freeze({
  issuer: "https://api.figma.com",
  authorizationUrl: "https://www.figma.com/oauth/mcp",
  tokenUrl: "https://api.figma.com/v1/oauth/token",
  registrationUrl: "https://api.figma.com/v1/oauth/mcp/register",
});
export const CALLBACK_PATH = "/callback";
export const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}
export interface OAuthGrant extends RegisteredClient {
  access: string;
  refresh: string;
  /** OMP consumes absolute milliseconds, not Unix seconds. */
  expires: number;
  tokenUrl: string;
  authorizationUrl: string;
  scope?: string;
}
export interface FlowOptions {
  clientName: string;
  port: number;
  signal?: AbortSignal;
  onAuthorizationUrl: (url: string, callbackUrl: string) => void | Promise<void>;
  /** Test seams only. No CLI option can change the remote URLs. */
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

const OAUTH_ERRORS: Record<string, true> = {
  invalid_request: true, invalid_client: true, invalid_grant: true,
  unauthorized_client: true, unsupported_grant_type: true, invalid_scope: true,
  access_denied: true, unsupported_response_type: true, server_error: true,
  temporarily_unavailable: true, invalid_redirect_uri: true,
  invalid_client_metadata: true, invalid_token: true, insufficient_scope: true,
};
function oauthError(value: unknown): string {
  return typeof value === "string" && Object.hasOwn(OAUTH_ERRORS, value)
    ? value : "oauth_error";
}
export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("Invalid OAuth JSON response.");
  }
  return value as Record<string, unknown>;
}
function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 65536 || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new UserError(`Invalid OAuth field: ${field}.`);
  }
  return value;
}
function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}
function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UserError(`Invalid OAuth field: ${field}.`);
  }
  return value;
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof UserError
    ? signal.reason : new UserError("Figma authorization cancelled.");
}
/** Also bounds test/injected fetch implementations that ignore AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof UserError
      ? signal.reason : new UserError("Figma authorization cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function fetchJson(
  fetcher: FetchLike, url: string, init: RequestInit, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  aborted(signal);
  let response: Response;
  try {
    response = await abortable(fetcher(url, { ...init, signal, redirect: "error" }), signal);
  } catch {
    aborted(signal);
    throw new UserError("OAuth network request failed (redirects are disabled).");
  }
  let body: unknown;
  try {
    body = await abortable(response.json(), signal);
  } catch {
    aborted(signal);
    throw new UserError(`OAuth HTTP ${response.status}: invalid JSON response.`);
  }
  const data = objectValue(body);
  if (!response.ok || data.error !== undefined) {
    throw new UserError(`OAuth HTTP ${response.status}${data.error === undefined ? "" : `: ${oauthError(data.error)}`}.`);
  }
  return data;
}

export async function discoverEndpoints(fetcher: FetchLike, signal: AbortSignal): Promise<typeof ENDPOINTS> {
  const data = await fetchJson(fetcher, DISCOVERY_URL, {}, signal);
  if (data.issuer !== ENDPOINTS.issuer ||
      data.authorization_endpoint !== ENDPOINTS.authorizationUrl ||
      data.token_endpoint !== ENDPOINTS.tokenUrl ||
      data.registration_endpoint !== ENDPOINTS.registrationUrl ||
      !Array.isArray(data.code_challenge_methods_supported) ||
      !data.code_challenge_methods_supported.includes("S256")) {
    throw new UserError("Figma OAuth discovery contains an untrusted endpoint or does not support S256.");
  }
  return ENDPOINTS;
}
export async function registerClient(
  fetcher: FetchLike, redirectUri: string, clientName: string, signal: AbortSignal,
): Promise<RegisteredClient> {
  const data = await fetchJson(fetcher, ENDPOINTS.registrationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: clientName,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }, signal);
  return {
    clientId: stringValue(data.client_id, "client_id"),
    clientSecret: optionalString(data.client_secret, "client_secret"),
    clientIdIssuedAt: optionalTimestamp(data.client_id_issued_at, "client_id_issued_at"),
    clientSecretExpiresAt: optionalTimestamp(data.client_secret_expires_at, "client_secret_expires_at"),
  };
}
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export function parseTokens(data: Record<string, unknown>, now: number): Pick<OAuthGrant, "access" | "refresh" | "expires" | "scope"> {
  const access = stringValue(data.access_token, "access_token");
  const refresh = stringValue(data.refresh_token, "refresh_token (required for OMP refresh)");
  if (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer") {
    throw new UserError("OAuth token_type must be Bearer.");
  }
  const duration = typeof data.expires_in === "string" && /^\d+$/u.test(data.expires_in)
    ? Number(data.expires_in) : data.expires_in;
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0 ||
      !Number.isSafeInteger(now) || now < 0 ||
      !Number.isSafeInteger(now + duration * 1000) || now + duration * 1000 > 8.64e15) {
    throw new UserError("OAuth expires_in must be a positive, safely representable duration.");
  }
  return { access, refresh, expires: now + duration * 1000, scope: optionalString(data.scope, "scope") };
}
export async function exchangeCode(
  fetcher: FetchLike, client: RegisteredClient, redirectUri: string,
  code: string, verifier: string, signal: AbortSignal, now: () => number = Date.now,
): Promise<OAuthGrant> {
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: redirectUri,
    client_id: client.clientId, code_verifier: verifier,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const data = await fetchJson(fetcher, ENDPOINTS.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, signal);
  return { ...client, ...parseTokens(data, now()), tokenUrl: ENDPOINTS.tokenUrl, authorizationUrl: ENDPOINTS.authorizationUrl };
}

export interface CallbackListener {
  callbackUrl: string;
  result: Promise<string>;
  close: () => Promise<void>;
}
export async function listenForCallback(port: number, state: string, signal: AbortSignal): Promise<CallbackListener> {
  aborted(signal);
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  let settled = false;
  let closing: Promise<void> | undefined;
  const result = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Discovery/DCR can fail before the caller awaits result. Observe rejection immediately.
  void result.catch(() => {});
  const fail = (error: UserError) => {
    if (!settled) { settled = true; rejectCode(error); }
  };
  let server: Server;
  const close = (): Promise<void> => {
    if (closing) return closing;
    signal.removeEventListener("abort", onAbort);
    fail(new UserError("Figma authorization cancelled."));
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  const onAbort = () => {
    fail(signal.reason instanceof UserError ? signal.reason : new UserError("Figma authorization cancelled."));
    void close();
  };
  server = createServer((req, res) => {
    const reply = (status: number, text: string) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "Connection": "close",
        "Content-Security-Policy": "default-src 'none'",
      });
      res.end(text);
    };
    if (settled) { reply(410, "Authorization already completed."); return; }
    if (req.method !== "GET") { reply(405, "GET required."); return; }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) { reply(400, "Bad callback."); return; }
    let url: URL;
    try { url = new URL(req.url, "http://127.0.0.1"); }
    catch { reply(400, "Bad callback."); return; }
    if (url.pathname !== CALLBACK_PATH) { reply(404, "Not found."); return; }
    const states = url.searchParams.getAll("state");
    const received = Buffer.from(states[0] ?? "");
    const expected = Buffer.from(state);
    if (states.length !== 1 || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      reply(400, "Invalid OAuth state."); return;
    }
    // Validate state before processing errors: unrelated requests cannot abort login.
    const errors = url.searchParams.getAll("error");
    const codes = url.searchParams.getAll("code");
    const issuers = url.searchParams.getAll("iss");
    if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== ENDPOINTS.issuer)) {
      reply(400, "Invalid OAuth issuer."); return;
    }
    if (errors.length === 1 && codes.length === 0) {
      reply(400, "Authorization was not granted. Return to OMP.");
      fail(new UserError(`OAuth callback: ${oauthError(errors[0])}.`));
      return;
    }
    if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 65536 || /[\x00-\x1f\x7f]/u.test(codes[0])) {
      reply(400, "Invalid OAuth callback."); return;
    }
    settled = true;
    reply(200, "Authorization code received. Return to OMP to confirm token exchange completed.");
    resolveCode(codes[0]);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on("error", () => {
    fail(new UserError("OAuth callback listener failed."));
    void close();
  });
  // Await bind before installing abort cleanup; an abort during bind is checked immediately after.
  try {
    await new Promise<void>((resolve, reject) => {
      const bindError = () => reject(new UserError("Unable to bind OAuth callback to 127.0.0.1."));
      server.once("error", bindError);
      server.listen(port, "127.0.0.1", () => { server.off("error", bindError); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new UserError("OAuth callback listener has no port.");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) { onAbort(); aborted(signal); }
    return { callbackUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`, result, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runOAuthFlow(options: FlowOptions): Promise<OAuthGrant> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new UserError("Figma authorization cancelled."));
  const timeoutMs = options.timeoutMs ?? AUTH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new UserError("Invalid OAuth timeout.");
  }
  const timer = setTimeout(() => controller.abort(new UserError("Figma authorization timed out.")), timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  let listener: CallbackListener | undefined;
  try {
    aborted(controller.signal);
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(32).toString("base64url");
    listener = await listenForCallback(options.port, state, controller.signal);
    await discoverEndpoints(fetcher, controller.signal);
    const client = await registerClient(fetcher, listener.callbackUrl, options.clientName, controller.signal);
    const url = new URL(ENDPOINTS.authorizationUrl);
    url.search = new URLSearchParams({
      response_type: "code", client_id: client.clientId, redirect_uri: listener.callbackUrl,
      code_challenge: challenge, code_challenge_method: "S256", state,
    }).toString();
    aborted(controller.signal);
    await abortable(Promise.resolve(options.onAuthorizationUrl(url.href, listener.callbackUrl)), controller.signal);
    const code = await listener.result;
    aborted(controller.signal);
    const grant = await exchangeCode(fetcher, client, listener.callbackUrl, code, verifier, controller.signal, options.now);
    aborted(controller.signal);
    return grant;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    // Cancel in-flight fetches as well as the listener on every exit path.
    controller.abort(new UserError("Figma authorization cancelled."));
    await listener?.close();
  }
}
