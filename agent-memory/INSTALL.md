# 给模型看的安装指南

这份文档是给**直接拿到仓库、被用户要求“帮我装上”的模型**看的。目标不是让用户回答一堆问题，而是先自己检测，再选 adapter。

## 0. 先检测，不要先问

在仓库根目录运行：

```bash
node agent-memory/install.mjs --dry-run --json
```

输出里有 `candidates` 和 `choice`。按这个顺序判断：

1. `choice.ok === true` → 直接用选中的 harness，执行下面的安装命令。
2. `choice.ambiguous === true` → 有多个 harness 都装过记忆。**这时才问用户**要用哪一个；不要替用户猜。
3. `candidates` 为空 → 没发现 DSH / OpenCode / WorkBuddy。问用户实际用的是哪个，或确认路径。
4. 只有一个候选但 `installed === false` → 说明软件在，但记忆没装过；可以装，但先确认用户要装的是这个。

## 1. 三个 adapter

| harness | 识别标记 | 安装命令 | 生效方式 |
|---|---|---|---|
| `dsh` | `~/.dsh/profiles/desktop/package.json`、`~/.dsh/dsh-memory/config.json` | `node agent-memory/install.mjs --harness dsh --workspace "<工作区>"` | 重启 DSH |
| `opencode` | `~/.config/opencode/opencode.json`、`~/.opencode-mem/` | `node agent-memory/install.mjs --harness opencode` | 配置热加载；必要时 `/reload` |
| `workbuddy` | `~/.workbuddy/settings.json`、`~/.workbuddy/skills/self-memory/` | `node agent-memory/install.mjs --harness workbuddy` | 重开 WorkBuddy |

`--dry-run` 只打印计划，不写文件。正式安装前先跑一次，确认 `adapter` 路径和动作对。

新增一个 harness 时，只需要在 `agent-memory/adapters/` 加一个文件（导出 `meta` 和 `plan()`），再在 `adapters/index.mjs` 登记；安装器和识别逻辑不用改。

每个 adapter 声明自己依赖的能力：

| adapter | capabilities |
|---|---|
| `dsh` | `session.event` / `systemPrompt.section` / `tools.register` |
| `opencode` | `session.hook` / `tool.transform` / `context.copy` |
| `workbuddy` | `hook.stdin` / `hook.process` / `pending.file` |

## 2. 安装时选择，运行时校验

- **安装时**由安装器选 adapter，写进对应 harness 的配置。
- 每个 adapter 在 `meta.capabilities` 里声明自己依赖的能力（见下表）。
- **当前阶段**后端仍按各自实现启动；运行时能力校验要等共享 core 接入时再做，不要把它当成已经生效的保证。
- 不要靠 `ctx.app.name` 或包名猜；版本一升级就会猜错。

## 3. 安全规则（必须遵守）

1. **不要删除或覆盖任何 `stream.jsonl`、`marks.jsonl`、`blobs/`、`episodes.jsonl`。**
2. **不要运行** `compact --apply`、`dedup` 的改写模式；原始账本只追加。
3. 改 `settings.json` / `opencode.json` / profile `package.json` 前必须备份；安装器已经会备份，手动改也要备份。
4. 不要把用户原话、密钥、完整记忆库贴进对话或日志。
5. 安装失败时不要连续重试；先读错误，确认是路径、权限还是版本问题。
6. 不要为了“一次装全”把三个都装上；只装用户实际在用的那个。

## 4. 安装后验证

### DSH

```bash
node ~/.dsh/profiles/node_modules/dsh-memory/cli.mjs health "<工作区>"
node ~/.dsh/profiles/node_modules/dsh-memory/cli.mjs verify "<工作区>"
```

期望看到 `账本 OK` / `ledger=OK`。旧数据第一次会显示 `UNTRACKED`，检查后用 `sync` 建基线；`sync` 不改原始记录。

### OpenCode

```bash
node tools/mem.mjs health
node tools/mem.mjs verify
```

期望 `ledger=OK`。旧记录显示 `老记录无指纹` 是正常的，不代表损坏。

### WorkBuddy

```bash
node ~/.workbuddy/skills/self-memory/bin/mem.mjs health
node ~/.workbuddy/skills/self-memory/bin/mem.mjs verify
```

期望 `账本 OK` / `ledger=OK`。

## 5. 装完怎么确认“真的在记”

不要只看日志说“已加载”。新开一个会话，说一句普通的话，然后查：

```bash
# OpenCode
node tools/mem.mjs trace "<刚说的那句话>"

# DSH
node ~/.dsh/profiles/node_modules/dsh-memory/cli.mjs trace "<工作区>" "<刚说的那句话>"

# WorkBuddy
node ~/.workbuddy/skills/self-memory/bin/mem.mjs trace "<刚说的那句话>"
```

查到原话，才算真的落盘。查不到就检查：

- 工作区路径是否在配置里；
- 插件是否加载（`diag.log`）；
- 是否装完还没重启；
- WorkBuddy 的 `PostToolUse` 是否已挂上（重开后才生效）。

## 6. 常见失败

| 现象 | 先查什么 |
|---|---|
| `没有发现 ...` | 软件是否装过、路径是否在默认位置；用 `--json` 看 `markers` |
| `多个 harness 都装过记忆` | 不要猜，问用户；再用 `--harness` |
| OpenCode 配置是 JSONC | 安装器不会强改；手动把 `plugin/self-memory` 绝对路径加进 `plugins` |
| DSH 装完没反应 | 是否重启；`~/.dsh/dsh-memory/diag.log` 最后几行 |
| WorkBuddy 没有工具结果 | 是否重开；`settings.json` 的 `hooks.PostToolUse` 是否存在 |
| `ledger=UNTRACKED` | 旧数据还没建基线；检查后 `sync` |
| `ledger=BAD` | 不要 `sync`；保留现场，从备份恢复后排查 |

## 7. 一句话决策树

```text
运行 --dry-run --json
├─ choice.ok 且 harness=dsh        → 装 dsh，重启
├─ choice.ok 且 harness=opencode   → 装 opencode，热加载
├─ choice.ok 且 harness=workbuddy  → 装 workbuddy，重开
├─ ambiguous                       → 问用户选哪个
└─ 没有候选                         → 问用户实际用什么
```
