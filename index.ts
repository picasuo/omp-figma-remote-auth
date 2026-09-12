import { COMMAND_NAME, FIGMA_URL, UserError, formatError, helpText, parseArgs } from "./src/args.ts";
import { isAuthorizationEntry, openBrowser } from "./src/browser.ts";
import type { Exec } from "./src/browser.ts";
import { inspectLegacyConfig } from "./src/config.ts";
import { migrateLegacyData } from "./src/migration.ts";
import { runOAuthFlow } from "./src/oauth.ts";
import type { FlowOptions, OAuthGrant } from "./src/oauth.ts";
import { legacyCredentialIdFor, nativeCredentialIdFor, resolveActiveProfile, credentialStatus, logout, saveCredential } from "./src/storage.ts";
import type { AuthStorage } from "./src/storage.ts";

/** Minimal structural interface; OMP supplies all runtime services, no SDK dependency. */
export interface CommandContext {
  signal?: AbortSignal;
  mode?: string;
  hasUI?: boolean;
  modelRegistry: { authStorage: AuthStorage };
  ui: {
    notify(message: string, level: "info" | "error"): void;
    setStatus?(key: string, message: string | undefined): void;
    setWidget?(key: string, factory: (() => unknown) | undefined, options?: { placement: "aboveEditor" }): void;
  };
}
export interface ExtensionAPI {
  pi: {
    getAgentDir(): string;
    Markdown?: new (text: string, paddingX: number, paddingY: number, theme: unknown) => unknown;
    getMarkdownTheme?: () => unknown;
  };
  exec?: Exec;
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: CommandContext): Promise<void>;
  }): void;
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
}
export interface Dependencies {
  runOAuth?: (options: FlowOptions) => Promise<OAuthGrant>;
  platform?: NodeJS.Platform;
}
// One active mutation across extension instances in this process, including during a reload.
let active: { controller: AbortController; done: Promise<void>; cleanup: () => void } | undefined;

// Host UI failures must not interrupt cancellation, listener cleanup, or completion.
function tryUI(action: () => void): void {
  try { action(); } catch { /* The host may already be disposing its UI. */ }
}

export default function figmaRemoteAuthExtension(pi: ExtensionAPI): void {
  registerExtension(pi);
}
export function registerExtension(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  let shuttingDown = false;
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    const pending = active;
    pending?.cleanup();
    pending?.controller.abort();
    await pending?.done;
  });
  pi.registerCommand(COMMAND_NAME, {
    description: "Authenticate official Figma Remote MCP using OMP native transport and refresh",
    handler: async (args, ctx) => {
      let finish: (() => void) | undefined;
      let cancel: (() => void) | undefined;
      let operation: typeof active;
      const notify = (message: string, level: "info" | "error") => tryUI(() => ctx.ui.notify(message, level));
      try {
        const command = parseArgs(args);
        if (command.kind === "help") { notify(helpText(), "info"); return; }
        if (command.kind === "cancel") {
          const pending = active;
          pending?.cleanup();
          pending?.controller.abort();
          await pending?.done;
          notify(pending ? "Figma authorization cancelled." : "No Figma authorization is running.", "info");
          return;
        }
        if (shuttingDown) throw new UserError("OMP is shutting down; authentication is unavailable.");
        const agentDir = pi.pi.getAgentDir();
        const profile = resolveActiveProfile();
        const credentialId = nativeCredentialIdFor(profile);
        const legacyId = legacyCredentialIdFor(agentDir);
        const storage = ctx.modelRegistry.authStorage;
        if (command.kind === "status") {
          const config = inspectLegacyConfig(agentDir, legacyId);
          ctx.ui.notify([
            `Figma Remote MCP: ${FIGMA_URL}`,
            "Config: package-provided MCP definition; runtime discovery and connection are not checked here.",
            "Install or link the full plugin package for MCP registration; loading index.ts alone is not an installation check.",
            `Legacy config: ${config.kind === "owned" ? "migration pending; run /figma-remote-auth login" : config.kind === "conflict" ? `conflict at ${config.path}; resolve before login` : "absent"}.`,
            credentialStatus(storage, credentialId),
            `Authorization: ${active ? "operation in progress" : "idle"}.`,
          ].join("\n"), "info");
          return;
        }
        if (active) throw new UserError("A Figma authentication operation is already running. Cancel it before starting another.");
        const controller = new AbortController();
        const done = new Promise<void>(resolve => { finish = resolve; });
        let cleaned = false;
        let widgetShown = false;
        let statusShown = false;
        let entryShown = false;
        const current = {
          controller, done,
          cleanup: () => {
            if (cleaned || active !== current) return;
            cleaned = true;
            if (widgetShown) tryUI(() => ctx.ui.setWidget?.(COMMAND_NAME, undefined));
            if (statusShown && active === current) tryUI(() => ctx.ui.setStatus?.(COMMAND_NAME, undefined));
          },
        };
        operation = current;
        active = operation;
        cancel = () => { current.cleanup(); controller.abort(); };
        ctx.signal?.addEventListener("abort", cancel, { once: true });
        if (ctx.signal?.aborted) cancel();
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        if (command.kind === "logout") {
          const removed = await logout(storage, credentialId, legacyId);
          notify(`${removed ? "Removed this plugin's Figma credential." : "No credential owned by this plugin was found."} Run /mcp reload.`, "info");
          return;
        }
        await migrateLegacyData(agentDir, storage, profile);
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        statusShown = true;
        tryUI(() => ctx.ui.setStatus?.(COMMAND_NAME, "Waiting for Figma authorization"));
        const grant = await (dependencies.runOAuth ?? runOAuthFlow)({
          clientName: command.clientName, port: command.port, signal: controller.signal,
          onAuthorizationReady: async ({ startUrl, callbackUrl }) => {
            if (controller.signal.aborted || cleaned || active !== current || entryShown) return;
            if (!isAuthorizationEntry(startUrl, callbackUrl)) throw new UserError("Invalid local Figma authorization entry.");
            entryShown = true;
            const interactive = ctx.hasUI === true && ctx.mode === "tui";
            const Markdown = pi.pi.Markdown;
            const getMarkdownTheme = pi.pi.getMarkdownTheme;
            let displayed = false;
            if (interactive && ctx.ui.setWidget && Markdown && getMarkdownTheme) {
              try {
                widgetShown = true;
                ctx.ui.setWidget(COMMAND_NAME, () => new Markdown(
                  '**[点击这里授权 Figma](<' + startUrl + '>)**\n\n浏览器未自动打开时，点击上方入口。取消：/figma-remote-auth cancel',
                  1, 0, getMarkdownTheme(),
                ), { placement: "aboveEditor" });
                displayed = true;
              } catch { /* Fall back to the validated plain entry below. */ }
            }
            if (controller.signal.aborted || cleaned || active !== current) return;
            if (!displayed) {
              notify(`Open this local entry in your browser to authorize Figma:\n${startUrl}\n\nUse /figma-remote-auth cancel to stop waiting.`, "info");
              if (interactive) notify("This host does not support the Figma authorization widget. Use the local entry above.", "info");
            }
            if (!interactive || !command.openBrowser || controller.signal.aborted || cleaned || active !== current) return;
            const opened = pi.exec && await openBrowser(startUrl, pi.exec.bind(pi), {
              platform: dependencies.platform ?? process.platform, signal: controller.signal,
            });
            if (!opened && !controller.signal.aborted && !cleaned && active === current) {
              notify("The browser could not be opened automatically. Use the Figma authorization entry above; authorization is still waiting.", "info");
            }
          },
        });
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        // Recheck the active profile, migration conflicts, and cancellation after the browser wait.
        if (resolveActiveProfile() !== profile) throw new UserError("The active OMP profile changed during authorization; credentials were not saved.");
        await migrateLegacyData(agentDir, storage, profile);
        if (controller.signal.aborted) throw new UserError("Figma authorization cancelled.");
        await saveCredential(storage, credentialId, grant);
        notify("Figma authorization saved. Run /mcp reload.", "info");
      } catch (error) {
        notify(formatError(error), "error");
      } finally {
        try {
          if (cancel) ctx.signal?.removeEventListener("abort", cancel);
          if (operation && active === operation) operation.cleanup();
        } finally {
          if (operation) {
            operation.controller.abort();
            if (active === operation) active = undefined;
            finish?.();
          }
        }
      }
    },
  });
}
