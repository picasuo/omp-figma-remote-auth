# Development / 开发指南

[English](#english) · [简体中文](#简体中文)

## English

For source changes and local testing. Requires OMP 18.1.17+ (verified on 18.1.17) and Git; tests require Node.js 22.6.0+ and npm.

### Link a source checkout

```sh
git clone https://github.com/picasuo/omp-figma-remote-auth.git
omp plugin link ./omp-figma-remote-auth
omp
```

Keep the checkout in place: OMP links to it. Follow the login and connection steps in [Installation and authorization](README.md#installation-and-authorization). After source changes, restart OMP or run `/reload-plugins`; run `/mcp reload` after MCP changes.

Use a package link to test the full plugin. `omp -e /path/to/index.ts` can test authentication commands, but command availability alone does not prove discovery of the package's MCP definition.

The plugin commands are `login`, `status`, `logout`, `cancel`, and `help`. Login runs `migrateLegacyData` before authorization; keep migration and credential ownership checks in that flow. MCP registration comes from the package's `.mcp.json`.

Run tests from the repository directory. No dependency installation or build is needed:

```sh
npm test
```

Tests use simulated OAuth and local loopback requests, with no public network access, real credentials, or browser launches. `npm publish` runs tests through `prepublishOnly`.

### Switch from a development link to npm

1. Record the checkout's `realpath` and the installed path, usually under `~/.omp/plugins/node_modules/`.
2. Run `omp plugin uninstall omp-figma-remote-auth`, then confirm its removal with `omp plugin list`.
3. If the installed path remains, inspect its type with `lstat`. Only `unlink` a proven symlink to that checkout; never recursively delete its target. Stop for a regular directory, another link, or an unverified path.
4. Install `@latest` using [Installation and authorization](README.md#installation-and-authorization). Confirm the installed `realpath` no longer points to the checkout, then restart OMP. Valid links into a package cache do not need removal.

Keep the full `omp plugin install ...@latest` command for regular installs: `omp install <bare-name>` can interpret a same-named local directory as a development link.

## 简体中文

用于源码修改和本地测试。需要 OMP 18.1.17+（已验证 18.1.17）和 Git；测试需要 Node.js 22.6.0+ 和 npm。

### 从源码链接

```sh
git clone https://github.com/picasuo/omp-figma-remote-auth.git
omp plugin link ./omp-figma-remote-auth
omp
```

OMP 链接到源码目录，请保留其位置。之后按[安装和授权](README.zh-CN.md#安装和授权)中的登录和连接步骤操作。修改源码后重启 OMP，或运行 `/reload-plugins`；MCP 变更后再运行 `/mcp reload`。

验证完整插件行为请使用包级 link。`omp -e /path/to/index.ts` 可用于测试认证命令，但不能仅凭命令可用就判定包内 MCP 已被发现。

插件命令为 `login`、`status`、`logout`、`cancel` 和 `help`。Login 在授权前调用 `migrateLegacyData`，迁移和凭据归属检查应保留在该流程中。MCP 注册由包内 `.mcp.json` 提供。

在仓库目录运行测试，无需安装依赖或构建：

```sh
npm test
```

测试使用模拟 OAuth 和本机回环地址，不访问公网、不读取真实凭据、不打开浏览器。`npm publish` 会通过 `prepublishOnly` 运行测试。

### 从开发链接切回 npm 包

1. 记录源码的 `realpath` 和安装路径（通常在 `~/.omp/plugins/node_modules/`）。
2. 执行 `omp plugin uninstall omp-figma-remote-auth`，用 `omp plugin list` 确认已移除。
3. 若安装路径残留，先用 `lstat` 确认类型：仅当它是指向该源码的符号链接时，才可 `unlink` 该链接；绝不递归删除目标。普通目录、其他链接或无法确认的路径应停止处理。
4. 按[安装和授权](README.zh-CN.md#安装和授权)安装 `@latest`，确认安装路径的 `realpath` 不再指向源码，然后重启 OMP。指向包缓存的合法链接无需删除。

普通安装请保留完整的 `omp plugin install ...@latest` 命令，避免 `omp install <裸包名>` 将同名本地目录判为开发链接。
