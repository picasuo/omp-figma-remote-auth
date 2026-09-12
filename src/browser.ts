import { UserError } from "./args.ts";

export type Exec = (
  command: string, args: string[], options: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/** Accept only the canonical local entry; reject URL parser normalization and hidden suffixes. */
export function isAuthorizationEntry(url: string, callbackUrl?: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/a\/[A-Za-z0-9_-]{22}$/u.exec(url);
  if (/[\x00-\x20\x7f]/u.test(url)) return false;
  if (!match || Number(match[1]) > 65535) return false;
  return callbackUrl === undefined || callbackUrl === `http://127.0.0.1:${match[1]}/callback`;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UserError("Figma authorization cancelled.");
}

export async function openBrowser(
  url: string, exec: Exec, options: { platform: NodeJS.Platform; signal?: AbortSignal },
): Promise<boolean> {
  checkCancelled(options.signal);
  if (!isAuthorizationEntry(url)) return false;
  let command: string;
  let args: string[];
  switch (options.platform) {
    case "darwin": command = "open"; args = [url]; break;
    case "linux": command = "xdg-open"; args = [url]; break;
    case "win32": command = "rundll32.exe"; args = ["url.dll,FileProtocolHandler", url]; break;
    default: return false;
  }
  try {
    const result = await exec(command, args, { timeout: 5000, signal: options.signal });
    checkCancelled(options.signal);
    return result.code === 0 && !result.killed;
  } catch {
    checkCancelled(options.signal);
    return false;
  }
}
