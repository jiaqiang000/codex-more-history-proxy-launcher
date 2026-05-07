# Codex 显示更多聊天记录 + 代理启动脚本

Codex 桌面端侧边栏默认只展示最近 50 个聊天记录。这个脚本的作用很直接：用它启动 Codex 后，可以把侧边栏聊天记录数量提高到 5000 个，同时给这一次启动出来的 Codex 单独设置本地 HTTP(S) 代理,解决Reconnecting问题。。

我写这个脚本主要是为了解决两个实际问题：

- Codex 默认只显示 50 个聊天记录，历史对话多了以后找起来很麻烦。
- 网络或接口访问不稳定时，Codex 容易出现 reconnecting、连接失败、接口请求异常等问题。通过本地代理启动 Codex，可以让这一次启动的 Codex 请求走代理，减少这类连接问题。

这个脚本不会修改系统代理，也不会改 Codex 安装包。代理和聊天记录扩容都只对这一次由脚本启动的 Codex 生效。

## 搜索关键词

Codex 聊天记录，Codex 历史记录，Codex 只显示 50 条，Codex 显示 5000 条聊天记录，Codex Recent Threads，Codex 侧边栏聊天记录，Codex 代理，Codex HTTP 代理，Codex HTTPS 代理，Codex reconnecting，Codex 连接失败，Codex 接口请求失败，Codex 启动脚本，Codex 桌面端，OpenAI Codex 桌面端，Clash 代理，本地代理，macOS Codex。

## 能做什么

- 把 Codex 侧边栏聊天记录从默认 50 个提高到 5000 个。
- 给 Codex 单独设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 等代理环境变量。
- 只影响这次脚本启动出来的 Codex，不污染当前终端，也不永久修改系统代理。
- 如果 Codex 更新后内部结构变了，脚本会直接失败退出，并关闭这次启动的 Codex，避免启动出一个半坏不坏的状态。
- 禁止用 `source` 执行，必须用 `bash` 执行，避免把当前 shell 替换掉。

## 文件说明

- `launch_codex_with_proxy_and_all_threads.sh`：入口脚本，负责设置代理环境变量，然后启动真正的 Node.js launcher。
- `launch_codex_all_threads.js`：负责启动 Codex、连接 Electron DevTools Protocol，并在运行时把聊天记录加载数量提高到 5000。

## 使用方式

```bash
bash ./launch_codex_with_proxy_and_all_threads.sh
```

默认配置是：

```bash
CODEX_PROXY=http://127.0.0.1:7890
CODEX_NO_PROXY=127.0.0.1,localhost
CODEX_THREAD_LIST_LIMIT=5000
```

如果你的代理端口不是 `7890`，可以这样临时改：

```bash
CODEX_PROXY=http://127.0.0.1:7891 \
bash ./launch_codex_with_proxy_and_all_threads.sh
```

如果你想调整聊天记录数量，比如改成 2000：

```bash
CODEX_THREAD_LIST_LIMIT=2000 \
bash ./launch_codex_with_proxy_and_all_threads.sh
```

也可以两个一起改：

```bash
CODEX_PROXY=http://127.0.0.1:7891 \
CODEX_THREAD_LIST_LIMIT=2000 \
bash ./launch_codex_with_proxy_and_all_threads.sh
```

## 环境要求

- macOS
- 已安装 Codex 桌面端，默认路径是 `/Applications/Codex.app`
- 当前环境可以运行 Node.js
- 如果要解决 reconnecting / 接口访问问题，需要本地代理可用，例如 Clash 监听 `127.0.0.1:7890`

## 注意事项

这个脚本依赖 Codex 桌面端内部前端实现。Codex 更新后，内部模块名或方法名可能变化，脚本也可能需要跟着调整。

脚本的策略是：如果补丁装不上，就直接退出并关闭这次启动的 Codex。这样至少不会因为脚本问题导致后续状态乱掉。

本项目不是 OpenAI 官方项目。
