export const SERVER_NAME = "figma";
export const FIGMA_URL = "https://mcp.figma.com/mcp";
export const COMMAND_NAME = "figma-remote-auth";

/** Only errors authored by this extension are safe to show to the user. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaRemoteAuthError";
  }
}

export function formatError(error: unknown): string {
  return error instanceof UserError
    ? error.message
    : "Figma authentication failed. No credentials were included in this error.";
}

export type Command =
  | { kind: "help" | "status" | "logout" | "cancel" }
  | { kind: "login"; clientName: string; port: number; openBrowser: boolean };

/** Small shell-style tokenizer; no expansion, execution, or environment access. */
function tokenize(input: string): string[] {
  const words: string[] = [];
  let value = "";
  let quote: string | undefined;
  let started = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      value += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(value);
      value = "";
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote || escaped) throw new UserError("Unclosed quote or escape in arguments.");
  if (started) words.push(value);
  return words;
}

export function parseArgs(input: string): Command {
  const [kind = "help", ...args] = tokenize(input);
  if (kind !== "login") {
    if (!["help", "status", "logout", "cancel"].includes(kind) || args.length) {
      throw new UserError("Invalid command or arguments. Use /figma-remote-auth help.");
    }
    return { kind: kind as "help" | "status" | "logout" | "cancel" };
  }
  let clientName = "Codex";
  let port = 0;
  let openBrowser = true;
  const seen = new Set<string>();
  for (let i = 0; i < args.length;) {
    const key = args[i++];
    if (!key || !["--client-name", "--port", "--no-browser"].includes(key) || seen.has(key)) {
      throw new UserError("Unknown or duplicate login option. Use /figma-remote-auth help.");
    }
    seen.add(key);
    if (key === "--no-browser") { openBrowser = false; continue; }
    const value = args[i++];
    if (value === undefined || value.startsWith("--")) {
      throw new UserError("Login option requires a value.");
    }
    if (key === "--client-name") {
      if (!value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/u.test(value)) {
        throw new UserError("Client name must contain 1–128 printable characters.");
      }
      clientName = value;
    } else {
      if (!/^\d{1,5}$/u.test(value) || Number(value) > 65535) {
        throw new UserError("Port must be an integer from 0 to 65535; 0 chooses a random port.");
      }
      port = Number(value);
    }
  }
  return { kind: "login", clientName, port, openBrowser };
}

export function helpText(): string {
  return [
    "/figma-remote-auth help",
    "/figma-remote-auth login [--client-name Codex] [--port 0] [--no-browser]",
    "/figma-remote-auth status",
    "/figma-remote-auth logout",
    "/figma-remote-auth cancel",
    "",
    `Server: ${SERVER_NAME} (${FIGMA_URL})`,
    "Figma MCP is managed by this plugin. Login migrates owned legacy configuration and credentials before authorization.",
    "Login opens your browser in the interactive TUI and displays a highlighted local authorization entry.",
    "Use --no-browser to open the short entry manually; RPC/print never open a browser automatically.",
    "Use /figma-remote-auth cancel or exit OMP to stop waiting and close the local entry.",
    "OMP handles MCP transport and token refresh. After login or logout, run /mcp reload.",
  ].join("\n");
}
