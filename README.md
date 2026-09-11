# omp-figma-remote-auth

[简体中文](README.zh-CN.md)

An unofficial [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) plugin for authenticating with the official Figma Remote MCP server at `https://mcp.figma.com/mcp`. It configures the `figma` server and performs browser OAuth login; OMP provides native MCP transport, tool discovery, and token refresh. This project is not affiliated with or endorsed by Figma or OpenAI.

## Requirements

- OMP **18.1.17 is the currently verified version**. Use 18.1.17+; compatibility with future releases is not guaranteed.
- A Figma account with access to the intended files, and a browser on the same machine as OMP for the local OAuth callback. Figma Desktop is not required. Git is only needed for source installation.
- Zero runtime package dependencies. No `pi-mcp-adapter`, `npm install`, or build step is needed. Development tests require Node.js 22.6.0+ and npm.
- OMP's npm installer requires the standalone `bun` command on `PATH`. A packaged OMP binary may not include it; see the [Bun installation guide](https://bun.com/docs/installation). This is an installer requirement, not a package dependency.

## Install and connect

Run this command in your **terminal (CLI)** to install from npm:

```sh
omp install omp-figma-remote-auth
```

Restart OMP, or enter `/reload-plugins` in an existing OMP session. No source checkout or separate `npm install -g` is required.

If OMP reports `Executable not found in $PATH: "bun"`, install Bun first. With Node.js/npm available, you can also supply Bun temporarily for this command:

```sh
npm exec --yes --package=bun -- omp install omp-figma-remote-auth
```

To develop the plugin or install from source instead:

```sh
git clone https://github.com/picasuo/omp-figma-remote-auth.git
omp plugin link ./omp-figma-remote-auth
```

For a source installation, keep the cloned directory in place: OMP links to it. Restart OMP or run `/reload-plugins` after linking.

The following are **slash commands inside OMP's interactive interface (TUI)**, not shell commands. Start OMP with `omp` if needed, then run:

```text
/figma-remote-auth setup
/figma-remote-auth login
```

`setup` configures the server without logging in. It is optional here because `login` runs setup automatically.

Open the displayed authorization URL manually in a browser on the same machine. With the default settings, Figma's consent page shows **Codex** as the application name; see the authentication explanation below. Approve access, keep OMP running for the callback to `http://127.0.0.1:<port>/callback`, and return to OMP to confirm that authorization was saved. The browser receiving the code alone does not confirm that token exchange succeeded.

After OMP confirms success, run these TUI commands:

```text
/mcp reload
/mcp test figma
```

You can then ask OMP to use Figma tools with a Figma file or node URL you can access.

## Commands

All commands in this table run in the OMP TUI.

| Command | Purpose |
| --- | --- |
| `/figma-remote-auth help` | Show usage; also the default with no subcommand. |
| `/figma-remote-auth setup` | Add or merge the native `figma` HTTP MCP configuration. |
| `/figma-remote-auth login` | Run setup, dynamically register a client, and display the browser authorization link. |
| `/figma-remote-auth status` | Check local configuration, credential presence/expiry, and any active operation; this is not a live connection test. |
| `/figma-remote-auth logout` | Delete only this plugin's credential for the active profile; keep the MCP configuration. |
| `/figma-remote-auth cancel` | Cancel the pending authorization and close its callback listener. |

`login` accepts `--client-name` (default `Codex`, 1–128 printable characters, not blank) and `--port` (default `0`, which lets the OS choose an available port; valid range 0–65535). For example:

```text
/figma-remote-auth login --client-name Codex --port 19876
```

Quote names containing spaces. A different client name may be rejected by Figma. Login times out after 10 minutes; `cancel` or exiting OMP also stops the wait. Run `/mcp reload` after setup, login, or logout so OMP picks up the change.

## Authentication, profiles, and limits

Each login sends `client_name: Codex` by default to Figma's dynamic client registration endpoint and receives a **new `client_id`**. It then uses the OAuth authorization code flow with PKCE S256 and state validation. It does not reuse or steal an existing Codex client ID, secret, or account token. The display name does not make this an official Codex integration. This is a compatibility workaround for Figma's client acceptance policy; Figma may change registration rules or endpoints and stop accepting it. See Figma's [client access policy](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/#which-mcp-clients-are-supported).

Setup writes to the **active OMP agent directory's `mcp.json`** (normally `~/.omp/agent/mcp.json`). With `omp --profile <name>`, perform setup, login, status, and logout in that same profile. Credential IDs are derived from the active agent directory and Figma endpoint, so authentication is not automatically shared between profiles. The plugin does not write project-local MCP configuration.

Access/refresh tokens and client registration data are saved through **OMP's native AuthStorage**. The `mcp.json` entry contains the server URL, transport type, and an OAuth `credentialId` reference, not the tokens. OMP handles subsequent token refresh.

Figma's [official rate limits and access documentation](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/) currently gives Starter users **up to 20 calls per month for tools that read data from Figma**, with some tools exempt. Limits depend on plan and seat, can change, and do not replace file permissions. This plugin does not increase or bypass quotas.

## Troubleshooting

- **Unknown slash command:** check `omp plugin list` in the terminal, then restart OMP or run `/reload-plugins`. Use `/figma-remote-auth ...` in the TUI; there is no `omp figma-remote-auth` CLI command. `/mcp ...` commands also belong in the TUI.
- **Existing configuration conflict:** setup refuses to overwrite a conflicting `mcpServers.figma` entry. Back up the active agent directory's `mcp.json`, then inspect that entry for a different URL/type, an `Authorization` header, another `auth` source, or old transport/token options such as `command`, `args`, `env`, or `oauth`. If migrating, remove or rename the obsolete entry after reviewing it, then rerun setup/login. Preserve unrelated servers. Also check project MCP configurations if OMP still resolves a different `figma` server. A credential ownership conflict requires resolving the other authentication source; the plugin will not overwrite it.
- **Browser callback fails or login stalls:** keep the browser and OMP on the same machine; a browser on your laptop cannot directly reach a remote SSH/container loopback listener. Check local port access, cancel the attempt, and retry with `--port 0` or an available fixed port. A failed login may leave setup in place without a saved credential.
- **Authentication still fails:** run `/figma-remote-auth status`, log in again with `/figma-remote-auth login`, then `/mcp reload` and `/mcp test figma`. OMP's `/mcp reauth figma` is its own generic OAuth flow; it does **not** invoke this plugin's login or its client-name registration behavior.
- **Permission or quota errors:** check the authorized Figma account, file access, plan, and seat against the official limits above; logging in again does not add quota.

## Logout and uninstall

Installing or linking the plugin does not log you in. Uninstalling it does not automatically clear credentials or remove the `figma` MCP configuration.

For credential cleanup, run `/figma-remote-auth logout` and `/mcp reload` in each profile you authorized **before uninstalling**. Logout deletes the local credential only; it does **not revoke the server-side authorization at Figma**. To revoke that authorization, remove the corresponding app authorization in your Figma account settings.

Uninstall from the terminal:

```sh
omp plugin uninstall omp-figma-remote-auth
```

Restart OMP or run `/reload-plugins`. If you also want to remove the server, delete only its `mcpServers.figma` entry from the relevant `mcp.json` and run `/mcp reload`. You can delete the clone after unlinking/uninstalling it. If already uninstalled, link it again to use logout in the original profile.

## Development and credits

From the repository directory, run `npm test`. Tests use Node's built-in test runner and need no `npm install`. `npm publish` runs the tests through `prepublishOnly` and publishes to the official npm registry. The package's `files` allowlist includes only the runtime source, documentation, and license.

[MIT licensed](LICENSE), with copyright notices for DianP and the omp-figma-remote-auth contributors. Adapted for OMP from [DianP/pi-figma-remote-auth](https://github.com/DianP/pi-figma-remote-auth). Thanks also to [sdaoudi/mcp-auth-helper](https://github.com/sdaoudi/mcp-auth-helper), which the original project referenced for the authentication approach.
