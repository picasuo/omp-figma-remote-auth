# omp-figma-remote-auth

[English](README.md)

为 [Oh My Pi（OMP）](https://github.com/can1357/oh-my-pi) 接入 Figma 官方远程 MCP，提供浏览器登录，连接和令牌刷新由 OMP 负责。非官方插件，与 Figma、OpenAI 无隶属关系。

## 安装和授权

需要 OMP 18.1.17+（已验证 18.1.17）、有文件访问权限的 Figma 账号，以及与 OMP 在同一台机器上的浏览器。无需 Figma Desktop 或手动编辑 MCP 配置。

### 1. 安装：在终端执行

```sh
omp plugin install omp-figma-remote-auth@latest
```

如果提示找不到 `bun`，可用 Node.js/npm 临时提供：

```sh
npm exec --yes --package=bun -- omp plugin install omp-figma-remote-auth@latest
```

安装后启动或重启 OMP：

```sh
omp
```

### 2. 登录：在 OMP 输入框执行

```text
/figma-remote-auth login
```

浏览器会自动打开。未打开时，点击编辑器上方的 **点击这里授权 Figma**，或复制完整短地址到浏览器。默认授权应用名称为 **Codex**，原因见[认证说明](#配置与认证说明)。

确认授权，等待 OMP 提示凭据已保存。

### 3. 验证连接：在 OMP 输入框执行

```text
/mcp reload
/mcp test figma
```

服务名为 `figma`。连接成功后，即可向 OMP 提供你有权限访问的 Figma 文件或节点链接。

插件还内置按需加载的 `figma-mcp` skill。提供 Figma 文件或节点链接后，它会引导 OMP 解析节点参数并发现 Figma MCP 工具，包括挂载在 `xd://` 下的工具。

## 常用命令

以下均在 **OMP TUI** 中执行，不是终端命令。

| 命令 | 用途 |
| --- | --- |
| `/figma-remote-auth login` | 登录或重新授权，自动处理必要迁移。 |
| `/figma-remote-auth status` | 查看本地凭据，不测试连接。 |
| `/figma-remote-auth cancel` | 取消授权，关闭短入口和监听端口。 |
| `/figma-remote-auth logout` | 清除本插件的本地凭据，不撤销 Figma 端授权。 |
| `/figma-remote-auth help` | 查看完整用法。 |
| `/mcp list` | 查看 MCP 服务。 |

登录加 `--no-browser` 可手动打开短入口；`--port` 指定端口（默认随机），`--client-name` 修改应用名称（默认 `Codex`）。完整用法见 `help`。

授权最多等待 **10 分钟**。流程结束、取消或退出 OMP 后释放监听端口；关闭浏览器不会取消等待。

## 卸载

在终端执行，然后重启 OMP：

```sh
omp plugin uninstall omp-figma-remote-auth
```

卸载会移除包提供的 Figma 注册，保留凭据供重装使用，独立的用户/项目配置不受影响。

如需清除凭据，卸载前在 OMP 中执行 `/figma-remote-auth logout` 和 `/mcp reload`。撤销 Figma 服务器端授权需到账号设置中操作。

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| 找不到插件命令 | 在终端用 `omp plugin list` 确认安装，再重启 OMP。 |
| MCP 未连接 | 确认完整插件包已安装，执行 `/mcp reload` 和 `/mcp test figma`。 |
| 回调失败或一直等待 | 取消后用 `/figma-remote-auth login --port 0` 重试。浏览器须能访问 OMP 所在机器的 `127.0.0.1`；SSH/容器不会自动配置端口转发。 |
| 配置或凭据冲突 | 检查提示路径，备份后再调整。插件不会覆盖自定义配置或其他来源的凭据。 |
| 认证失败 | 用 `/figma-remote-auth login` 重新登录，再 reload/test；`/mcp reauth figma` 不会调用本插件。 |
| 权限或额度不足 | 检查账号、文件权限及套餐，参见 [Figma 限额](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)。 |

## 配置与认证说明

- **配置与凭据：**包内 `.mcp.json` 提供 Figma 服务，新安装不写用户 MCP 配置。凭据由 OMP 保存和刷新；使用 profile 时，请在同一 profile 中登录。
- **授权应用名：**`Codex` 用于兼容 [Figma 客户端策略](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/#which-mcp-clients-are-supported)。每次登录注册独立客户端，不使用 Codex 的账号或凭据。
- **授权入口：**本机短链接转发完整 OAuth 请求，长授权 URL 和 token 不输出到终端。

## 许可证与致谢

[MIT](LICENSE)。改编自 [DianP/pi-figma-remote-auth](https://github.com/DianP/pi-figma-remote-auth)，其认证思路参考了 [sdaoudi/mcp-auth-helper](https://github.com/sdaoudi/mcp-auth-helper)。

源码安装与测试请参阅[开发指南](https://github.com/picasuo/omp-figma-remote-auth/blob/main/DEVELOPMENT.md#简体中文)。
