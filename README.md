# omp-figma-remote-auth

[简体中文](README.zh-CN.md)

Connect [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) to the official Figma Remote MCP server with browser login. OMP handles connections and token refresh. This unofficial plugin is not affiliated with Figma or OpenAI.

## Installation and authorization

Requires OMP 18.1.17+ (verified on 18.1.17), a Figma account with file access, and a browser on the same machine as OMP. No Figma Desktop or manual MCP configuration is needed.

### 1. Install in your terminal

```sh
omp plugin install omp-figma-remote-auth@latest
```

If `bun` is missing, use Node.js/npm to supply it temporarily:

```sh
npm exec --yes --package=bun -- omp plugin install omp-figma-remote-auth@latest
```

Start or restart OMP after installation:

```sh
omp
```

### 2. Log in from the OMP input box

```text
/figma-remote-auth login
```

Your browser opens automatically. If it does not, click **点击这里授权 Figma** (“Click here to authorize Figma”) above the editor, or copy the complete short URL into your browser. The default app name on the consent page is **Codex**; see [authentication details](#configuration-and-authentication).

Approve access and wait for OMP to confirm that credentials were saved.

### 3. Check the connection in OMP

```text
/mcp reload
/mcp test figma
```

The server name is `figma`. Once connected, give OMP a Figma file or node URL you can access.

The package also includes the on-demand `figma-mcp` skill. When you provide a Figma file or node link, it guides OMP through parsing the node reference and discovering the Figma MCP tools, including tools mounted under `xd://`.

### Figma skill routing limitation

The bundled `figma-mcp` skill is an OMP skill, not a copy of Figma's official workflow skill. Its purpose is to recognize Figma tasks, parse file/node references, select the right MCP tool, and guide tool discovery under `xd://`. It cannot rewrite the Figma MCP server's tool descriptions or intercept a `read` request already emitted by the model.

Figma's `get_design_context` guidance currently asks clients to read:

```text
skill://figma/figma-design-to-code/SKILL.md
```

In OMP, `skill://` is the local skill namespace. If the model follows that instruction literally, OMP can return `Unknown skill: figma` before the model reaches the plugin guidance. In the verified OMP 18.1.18 environment, the Figma MCP resource can instead be read with OMP's MCP-specific wrapper:

```text
read mcp://skill://figma/figma-design-to-code/SKILL.md
```

This workaround requires the Figma MCP server to be connected and to advertise that resource; `mcp://skill://...` is OMP-specific, not a general MCP URI syntax. A model may still first try the bare `skill://` path because the Figma tool description uses mandatory wording. Metadata queries that do not require this workflow resource may still work, but a `get_design_context` design-to-code request can fail or return incomplete results if the prerequisite resource is not loaded.

## Commands

These commands run **inside OMP's TUI**, not in your terminal.

| Command | Purpose |
| --- | --- |
| `/figma-remote-auth login` | Log in or reauthorize, handling necessary migration automatically. |
| `/figma-remote-auth status` | Show local credentials; does not test the connection. |
| `/figma-remote-auth cancel` | Cancel authorization and close the local entry and listener. |
| `/figma-remote-auth logout` | Clear this plugin's local credentials without revoking Figma authorization. |
| `/figma-remote-auth help` | Show full usage. |
| `/mcp list` | List MCP servers. |

Add `--no-browser` to open the short entry manually, `--port` to choose a port (random by default), or `--client-name` to change the app name (default `Codex`). See `help` for full usage.

Authorization waits up to **10 minutes**. Completion, cancellation, or exiting OMP releases the listener; closing the browser does not cancel the wait.

## Uninstall

Run this in your terminal, then restart OMP:

```sh
omp plugin uninstall omp-figma-remote-auth
```

Uninstalling removes the package's Figma registration and retains credentials for reinstalling. Independent user/project configuration is unaffected.

To clear credentials too, run `/figma-remote-auth logout` and `/mcp reload` in OMP before uninstalling. Revoke server-side authorization separately in your Figma account settings.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Plugin command not found | Check `omp plugin list` in your terminal, then restart OMP. |
| MCP not connected | Confirm the full package is installed, then run `/mcp reload` and `/mcp test figma`. |
| Callback fails or login keeps waiting | Cancel and retry with `/figma-remote-auth login --port 0`. The browser must reach `127.0.0.1` on the OMP machine; SSH/container forwarding is not configured automatically. |
| Config or credential conflict | Inspect the reported path and back up before editing. Custom config and credentials from other sources are not overwritten. |
| Authentication fails | Run `/figma-remote-auth login` again, then reload/test. `/mcp reauth figma` does not invoke this plugin. |
| Permission or quota error | Check the account, file access, and plan; see [Figma's limits](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/). |

## Configuration and authentication

- **Config and credentials:** the package's `.mcp.json` provides Figma MCP; new installs do not write user MCP config. OMP stores and refreshes credentials. When using profiles, log in within the same profile.
- **App name:** `Codex` accommodates [Figma's client policy](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/#which-mcp-clients-are-supported). Each login registers an independent client without using Codex accounts or credentials.
- **Authorization entry:** a local short URL forwards the complete OAuth request. Long authorization URLs and tokens are never printed in the terminal.

## License and credits

[MIT](LICENSE). Adapted from [DianP/pi-figma-remote-auth](https://github.com/DianP/pi-figma-remote-auth), whose authentication approach references [sdaoudi/mcp-auth-helper](https://github.com/sdaoudi/mcp-auth-helper).

For source installation and testing, see the [development guide](https://github.com/picasuo/omp-figma-remote-auth/blob/main/DEVELOPMENT.md#english).
