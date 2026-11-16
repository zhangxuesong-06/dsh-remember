# zcode-memory

给 ZCode 用的长期记忆插件。不是「记得去记」的那种——钩子自动把原话、工具调用与证据写进共享库，
需要回想时才调工具。

数据落在 `~/.agent-memory/zcode/`，与 OpenCode、DSH、WorkBuddy 共用同一个库；
跨库查询见 `agent-memory/recall.mjs`。

## 组成

| 部分 | 作用 |
|---|---|
| `hooks/hooks.json` | 挂 6 个事件：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、Stop |
| `bin/hook.mjs` | 每次事件起一个进程，只做解析 + 追加 + 注入；任何异常都 exit 0，绝不阻塞会话 |
| `bin/mcp.mjs` | 常驻 stdio MCP，暴露 `recall` / `trace` / `remember` / `memory_stats` / `memory_read` |
| `lib/*.mjs` | 内核：只增不改的流、切段、BM25 检索、身份锚/唤醒/到达/事实块、证据 blob |
| `tools/maintenance.mjs` | 校验、接纳基线、快照、保留 14 份、无引用 blob 清理、体积报告 |
| `bin/cli.mjs` | 人工核对：stats / health / maint / verify / show / recall / trace / replay / sync |

## 写入什么

- 用户原话（`user/message`），带 `ws`（规范化后的完整工作区路径）和 `wsName`（展示用）。
- 助手最后一段（`assistant/message`），完整保存、不截断。
- 工具调用与结果（`tool/call` / `tool/result`），入参与完整结果存成 `blobs/<sha256>`。
- 写入类工具改动过的文件（`artifact`），保存改前/改后两个版本。
- 每场会话第一条用户话顺手写一条 `session/title`，让检索有标题可用。

## 边界

- 只在 `hooks.json` 里挂的工具名上记工具（Bash / Write / Edit / ApplyPatch / MultiEdit / NotebookEdit），
  Read/Grep 之类只读调用不落盘——它们不进上下文，记了也只是噪声。
- 流超过 5 MB 后，钩子里不再建索引做预激活（函数仍然能用，只是不主动浮线索），
  避免每次输入多等几百毫秒。
- `verify` 的 OK 只证明已接纳字节没被改过，不证明内容真实，也不证明基线之前没丢过。

## 维护

SessionStart 会 detached 触发 `tools/maintenance.mjs --due`，默认 12 小时一次；
`ZCODE_DISABLE_MAINTENANCE=1` 关闭，`ZCODE_MEM_MAINTENANCE_INTERVAL_HOURS` 调间隔。

```bash
node zcode-memory/bin/cli.mjs health
node zcode-memory/bin/cli.mjs maint report     # 体积与分类计数
node zcode-memory/bin/cli.mjs maint verify
node zcode-memory/bin/cli.mjs maint sync       # 接纳合法尾巴为基线
node zcode-memory/bin/cli.mjs maint prune      # 只试算；加 --apply 才删
node zcode-memory/bin/cli.mjs maint backup     # 快照 + 保留 14 份
```

维护只处理已接纳的完整行：半行、坏 JSON、引用扫描失败时拒绝 prune，不猜。

## 手动验证

```bash
node zcode-memory/test.mjs
node zcode-memory/bin/cli.mjs stats
node zcode-memory/bin/cli.mjs health
node agent-memory/recall.mjs sources
```

## 配置

`~/.agent-memory/zcode/config.json`，首次运行自动生成。常用字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `capture` | `true` | 工具调用是否落盘 |
| `workspaces` | `[]` | 空 = 全部工作区；写路径则只记这些 |
| `exclude` | 临时目录 / node_modules / .git | 按子串排除 |
| `perTurnPriming` | `true` | 每轮给 0–3 条「这事以前碰过」 |
| `anchor` / `arrival` / `facts` | `true` | 会话开场注入哪几块 |
| `redact` | `false` | 写入前抹掉明显的密钥（默认关，原话优先） |
| `maxBlobBytes` | 2 MiB | 单文件快照上限 |
