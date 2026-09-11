# omp-figma-remote-auth

[English](README.md)

用于登录 Figma 官方远程 MCP 服务 `https://mcp.figma.com/mcp` 的非官方 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) 插件。它配置 `figma` 服务并完成浏览器 OAuth 登录，由 OMP 原生负责 MCP 传输、工具发现和令牌刷新。本项目与 Figma、OpenAI 无隶属关系，也未获其官方背书。

## 使用要求

- **OMP 18.1.17 是目前验证过的版本**。建议使用 18.1.17+，但不保证未来版本兼容。
- Git、拥有目标文件访问权限的 Figma 账号，以及与 OMP 运行在同一台机器上的浏览器，用于接收本地 OAuth 回调。无需 Figma 桌面客户端。
- 零运行时包依赖，无需 `pi-mcp-adapter`、`npm install` 或构建。开发测试需要 Node.js 22.6.0+ 和 npm。

## 安装与连接

在**终端（CLI）**中，进入希望保留仓库副本的目录后执行：

```sh
git clone https://github.com/picasuo/omp-figma-remote-auth.git
omp plugin link ./omp-figma-remote-auth
```

保留克隆目录的位置，OMP 会链接到该目录。重启 OMP，或在已有 OMP 会话中输入 `/reload-plugins`。

以下是 **OMP 交互界面（TUI）中的斜杠命令**，不能直接在 shell 中运行。需要时先用 `omp` 启动 OMP，然后执行：

```text
/figma-remote-auth setup
/figma-remote-auth login
```

`setup` 只配置服务，不登录。此处可以省略，因为 `login` 会自动执行 setup。

在同一台机器的浏览器中手动打开输出的授权链接。默认设置下，Figma 授权页显示的应用名称是 **Codex**，原因见下方认证机制说明。确认授权并保持 OMP 运行，浏览器会回调 `http://127.0.0.1:<port>/callback`。返回 OMP 确认凭据已保存；浏览器收到授权码并不代表令牌交换已经成功。

OMP 提示成功后，在 TUI 中执行：

```text
/mcp reload
/mcp test figma
```

随后可向 OMP 提供自己有权限访问的 Figma 文件或节点链接，让它使用 Figma 工具。

## 命令

下表所有命令均在 OMP TUI 中执行。

| 命令 | 用途 |
| --- | --- |
| `/figma-remote-auth help` | 查看帮助；不带子命令时也会显示帮助。 |
| `/figma-remote-auth setup` | 添加或合并原生 `figma` HTTP MCP 配置。 |
| `/figma-remote-auth login` | 自动 setup、动态注册客户端，并显示浏览器授权链接。 |
| `/figma-remote-auth status` | 检查本地配置、凭据是否存在及到期时间、当前操作状态；不进行实际连接测试。 |
| `/figma-remote-auth logout` | 仅删除当前 profile 中属于本插件的凭据，保留 MCP 配置。 |
| `/figma-remote-auth cancel` | 取消正在等待的授权，关闭回调监听。 |

`login` 支持 `--client-name`（默认 `Codex`，1–128 个可打印字符，不能全为空白）与 `--port`（默认 `0`，由操作系统选择可用端口；有效范围为 0–65535）。例如：

```text
/figma-remote-auth login --client-name Codex --port 19876
```

含空格的名称需加引号。Figma 可能拒绝其他客户端名称。登录会在 10 分钟后超时；执行 `cancel` 或退出 OMP 也会结束等待。setup、login 或 logout 后均应运行 `/mcp reload`，使 OMP 加载变更。

## 认证机制、profile 与限额

每次登录默认向 Figma 动态客户端注册端点发送 `client_name: Codex`，获取一个**新的 `client_id`**，再通过带 PKCE S256 和 state 校验的 OAuth 授权码流程登录。插件不会复用或偷用已有 Codex 的客户端 ID、密钥或账号令牌。显示名称也不代表这是官方 Codex 集成。这是针对 Figma 客户端准入策略的兼容方案；Figma 可能修改注册规则或端点，使其失效。参见 Figma 的[客户端访问策略](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/#which-mcp-clients-are-supported)。

Setup 写入**当前 OMP agent 目录下的 `mcp.json`**（通常为 `~/.omp/agent/mcp.json`）。使用 `omp --profile <name>` 时，应在同一个 profile 中执行 setup、login、status 和 logout。凭据 ID 根据当前 agent 目录和 Figma 端点生成，因此各 profile 不会自动共享登录状态。插件不写入项目级 MCP 配置。

访问令牌、刷新令牌及客户端注册信息通过 **OMP 原生 AuthStorage** 保存。`mcp.json` 中仅保存服务 URL、传输类型和 OAuth `credentialId` 引用，不保存令牌。后续令牌刷新由 OMP 处理。

Figma 的[官方限额与访问说明](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)目前规定：Starter 用户对**从 Figma 读取数据的工具，每月最多调用 20 次**，部分工具不计入该限额。额度取决于套餐和席位，可能变更，且不替代文件访问权限。本插件不会增加或绕过额度。

## 常见问题

- **找不到斜杠命令：**在终端用 `omp plugin list` 检查插件，再重启 OMP 或运行 `/reload-plugins`。`/figma-remote-auth ...` 应在 TUI 中输入，不存在 `omp figma-remote-auth` CLI 命令。`/mcp ...` 同样属于 TUI 命令。
- **已有配置冲突：**setup 不会覆盖有冲突的 `mcpServers.figma`。先备份当前 agent 目录的 `mcp.json`，检查该条目是否存在不同的 URL/type、`Authorization` 请求头、其他 `auth` 来源，或 `command`、`args`、`env`、`oauth` 等旧传输或令牌选项。迁移时，确认后删除或重命名旧条目，再执行 setup/login，保留其他服务。如果 OMP 仍加载了另一个 `figma` 服务，还需检查项目级 MCP 配置。若提示凭据归属冲突，应先解决其他认证来源的占用，插件不会覆盖它。
- **浏览器回调失败或一直等待：**浏览器和 OMP 应运行在同一台机器上；笔记本浏览器无法直接连接远程 SSH 主机或容器的回环监听。检查本地端口访问，取消当前操作后用 `--port 0` 或一个可用的固定端口重试。登录失败后，setup 配置可能已写入，但凭据尚未保存。
- **仍然认证失败：**运行 `/figma-remote-auth status`，用 `/figma-remote-auth login` 重新登录，然后执行 `/mcp reload` 与 `/mcp test figma`。OMP 的 `/mcp reauth figma` 走其自身通用 OAuth 流程，**不会调用本插件的 login，也不会使用本插件的客户端名称注册逻辑**。
- **权限或额度错误：**检查授权的 Figma 账号、文件权限、套餐和席位，并参照上方官方限额；重新登录不会增加额度。

## 退出登录与卸载

安装或链接插件不会自动登录；卸载插件也不会自动清除凭据或删除 `figma` MCP 配置。

如需清理凭据，请在**卸载前**进入每个曾授权的 profile，执行 `/figma-remote-auth logout` 和 `/mcp reload`。Logout 仅删除本地凭据，**不会撤销 Figma 服务器端授权**。如需撤销，请在 Figma 账号设置中移除对应应用的授权。

在终端执行卸载：

```sh
omp plugin uninstall omp-figma-remote-auth
```

重启 OMP 或运行 `/reload-plugins`。如需同时删除服务，仅从对应的 `mcp.json` 中删除 `mcpServers.figma` 条目，再运行 `/mcp reload`。解除链接或卸载后可以删除克隆目录。如果已经卸载，可重新链接插件，再进入原 profile 执行 logout。

## 开发与致谢

在仓库目录执行 `npm test`。测试使用 Node 内置测试运行器，无需 `npm install`。包元数据和 `prepublishOnly` 已为后续 npm 发布做准备；正式发布前请使用上方 Git clone/link 安装方式。

本项目采用 [MIT 许可证](LICENSE)，保留 DianP 与 omp-figma-remote-auth contributors 的版权声明。由 [DianP/pi-figma-remote-auth](https://github.com/DianP/pi-figma-remote-auth) 适配到 OMP。同时感谢 [sdaoudi/mcp-auth-helper](https://github.com/sdaoudi/mcp-auth-helper)，原项目曾参考其认证思路。
