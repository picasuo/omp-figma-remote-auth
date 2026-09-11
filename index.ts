import { COMMAND_NAME, FIGMA_URL, UserError, formatError, helpText, parseArgs } from "./src/args.ts";
import { configStatus, setupConfig } from "./src/config.ts";
import { runOAuthFlow } from "./src/oauth.ts";
import type { FlowOptions, OAuthGrant } from "./src/oauth.ts";
import { credentialIdFor, credentialStatus, logout, ownedCredential, saveCredential } from "./src/storage.ts";
import type { AuthStorage } from "./src/storage.ts";

/** Minimal structural interface; OMP supplies all runtime services, no SDK dependency. */
export interface CommandContext {
  signal?: AbortSignal;
  modelRegistry: { authStorage: AuthStorage };
  ui: {
    notify(message: string, level: "info" | "error"): void;
    setStatus?(key: string, message: string | undefined): void;
  };
}
export interface ExtensionAPI {
  pi: { getAgentDir(): string };
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: CommandContext): Promise<void>;
  }): void;
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
}
export interface Dependencies {
  runOAuth?: (options: FlowOptions) => Promise<OAuthGrant>;
}
// One active mutation across extension instances in this process, including during a reload.
let active: { controller: AbortController; done: Promise<void> } | undefined;

export default function figmaRemoteAuthExtension(pi: ExtensionAPI): void {
  registerExtension(pi);
}
export function registerExtension(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  let shuttingDown = false;
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const pending = active;
    pending?.controller.abort();
    await pending?.done;
  });
  pi.registerCommand(COMMAND_NAME, {
    description: "Authenticate official Figma Remote MCP using OMP native transport and refresh",
    handler: async (args, ctx) => {
      let finish: (() => void) | undefined;
      let cancel: (() => void) | undefined;
      let operation: typeof active;
      try {
        const command = parseArgs(args);
        if (command.kind === "help") { ctx.ui.notify(helpText(), "info"); return; }
        if (command.kind === "cancel") {
          const pending = active;
          pending?.controller.abort();
          await pending?.done;
          ctx.ui.notify(pending ? "Figma authorization cancelled." : "No Figma authorization is running.", "info");
          return;
        }
        if (shuttingDown) throw new UserError("OMP is shutting down; authentication is unavailable.");
        const agentDir = pi.pi.getAgentDir();
        const credentialId = credentialIdFor(agentDir);
        const storage = ctx.modelRegistry.authStorage;
        if (command.kind === "status") {
          const config = configStatus(agentDir, credentialId);
          ctx.ui.notify([
            `Figma Remote MCP: ${FIGMA_URL}`,
            `Config: ${config.configured ? "configured" : "setup required"}.`,
            credentialStatus(storage, credentialId),
            `Authorization: ${active ? "operation in progress" : "idle"}.`,
          ].join("\n"), "info");
          return;
        }
        if (active) throw new UserError("A Figma authentication operation is already running. Cancel it before starting another.");
        const controller = new AbortController();
        const done = new Promise<void>(resolve => { finish = resolve; });
        operation = { controller, done };
        active = operation;
        cancel = () => controller.abort();
        ctx.signal?.addEventListener("abort", cancel, { once: true });
        if (ctx.signal?.aborted) cancel();
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        if (command.kind === "logout") {
          const removed = await logout(storage, credentialId);
          ctx.ui.notify(`${removed ? "Removed this plugin's Figma credential." : "No credential owned by this plugin was found."} Run /mcp reload.`, "info");
          return;
        }
        // Protect credential ownership before setup changes the configured auth source.
        ownedCredential(storage, credentialId);
        setupConfig(agentDir, credentialId);
        if (command.kind === "setup") {
          ctx.ui.notify("Figma MCP configured. Use /figma-remote-auth login to authorize, then run /mcp reload.", "info");
          return;
        }
        ctx.ui.setStatus?.(COMMAND_NAME, "Waiting for Figma authorization");
        const grant = await (dependencies.runOAuth ?? runOAuthFlow)({
          clientName: command.clientName, port: command.port, signal: controller.signal,
          onAuthorizationUrl: (url) => {
            ctx.ui.notify(`Open this URL in your browser to authorize Figma:\n${url}\n\nReturn to OMP when finished. Use /figma-remote-auth cancel to stop waiting.`, "info");
          },
        });
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        // Recheck config and ownership after the browser wait before persisting credentials.
        const config = configStatus(agentDir, credentialId);
        if (!config.configured) throw new UserError("Figma configuration changed during authorization; credentials were not saved.");
        await saveCredential(storage, credentialId, grant);
        ctx.ui.notify("Figma authorization saved. Run /mcp reload.", "info");
      } catch (error) {
        ctx.ui.notify(formatError(error), "error");
      } finally {
        if (cancel) ctx.signal?.removeEventListener("abort", cancel);
        if (operation) {
          operation.controller.abort();
          if (active === operation) active = undefined;
          // Resolve first: UI failures must never strand session_shutdown waiting for cleanup.
          finish?.();
          ctx.ui.setStatus?.(COMMAND_NAME, undefined);
        }
      }
    },
  });
}
