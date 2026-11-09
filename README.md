# agent-memory

给 agent 用的长期记忆。三个 harness、一套共用的原则和证据格式。

| 目录 | 是什么 | 装在哪 |
|---|---|---|
| `agent-memory/` | 通用安装/识别层：检测 harness，选对应 adapter | 仓库根目录运行 |
| `dsh-memory/` | DSH 插件：按工作区隔离，挂 `session/event` 自动落盘 | `~/.dsh/profiles/node_modules/` |
| `plugin/self-memory/` | OpenCode 插件：全局一个库，挂 `prompt` / `context` / 工具事件 | 全局 `opencode.json` 的 `plugins` |
| `workbuddy-memory/` | WorkBuddy skill：hook 每次起进程，前后配对靠 `pending.json` | `~/.workbuddy/skills/self-memory/` |
| `tools/` | OpenCode 的存储与检索（CLI 和插件共用） | — |

三个实现都能**不靠模型自觉**地记录：消息发生时就落盘，不是等模型想起来调工具。

---

## 通用安装器：先识别，再选 adapter

```bash
node agent-memory/install.mjs --dry-run
node agent-memory/install.mjs --harness dsh --workspace "D:\deepseek harness"
node agent-memory/install.mjs --harness opencode
node agent-memory/install.mjs --harness workbuddy
```

`--dry-run` 只打印识别结果和计划，不写文件。默认 `auto` 只自动选“已经装过记忆”的那一个；多个就要求显式 `--harness`，不猜。

如果用户直接把仓库丢给模型，让它读 [`agent-memory/INSTALL.md`](agent-memory/INSTALL.md)——那份是给模型看的安装指南，包含识别规则、adapter 选择、安全约束和验证命令。

**当前阶段**：安装入口统一了，三个后端仍是各自已经跑通的实现；共享 core 和运行时 MCP 入口是下一步的收敛，不在这一版里强行重写。

---

## 共同的三条原则

1. **记录不经过模型。** 挂钩子，事件发生时直接追加。模型一忙就会漏，漏了那段就不存在。
2. **摘要只当索引。** 每轮只给「这事你以前碰过」的编号和日期；要细节就翻原话。
3. **真相永远回原文。** `trace` 按字查，核对消息角色；承诺还要看引用上下文。系统生成的任务摘要不能当作当事人的发言。

---

## dsh-memory（DSH）

```powershell
cd dsh-memory
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Workspace "D:\你的工作区"
```

零依赖，不需要 `npm install`。装完改 `~/.dsh/dsh-memory/config.json` 里的 `workspaces`，重启 DSH。

四个工具：`recall`（按意思）、`trace`（按字）、`remember`（特意记下）、`memory_stats`（看库）。

数据在 `~/.dsh/dsh-memory/<工作区>-<哈希>/`，`stream.jsonl` 是唯一真相。

---

## self-memory（OpenCode）

**必须装在全局**，不然只有当前工作区会记。加进 `~/.config/opencode/opencode.json`：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/plugin/self-memory"]
}
```

插件按 location 实例化：每个工作区一份实例，`ctx.location.directory` 就是那个工作区。
数据全部写进同一个 `~/.opencode-mem/`，靠 `ws` 标签区分。

用户文本由 `prompt` 钩子在接纳时保存，用户入箱事件作补充；助手文本由文本结束事件保存，`context` 从规范会话补记可见文本，中断回复标作观察值，每次模型续调都注入有界背景副本。工具 before/after 保存调用、完成或错误证据，成功写入后关联文件前后版本。idle 和执行结束事件自动生成带来源链接的任务记录。

六个 `mem` 工具：`recall` / `read` / `trace` / `remember` / `map` / `alias`。检索先给摘录与编号，`read` 可分段读取完整原文、工具结果或文件版本。方案原因保留在助手原文中，自动任务记录不猜原因。

数据在 `~/.opencode-mem/`，**全局一个库**，每条带 `ws` 标签——换文件夹不该等于换一个人。

CLI 兜底：

```bash
node tools/mem.mjs brief
node tools/mem.mjs recall "分块多大"
node tools/mem.mjs trace "扫码走局域网"
node tools/mem.mjs add "结论" --kind decision
node tools/mem.mjs show 123 --offset 0 --limit 12000
node tools/mem.mjs verify
node tools/mem.mjs health
node tools/mem.mjs replay
node --test tools/tests/memory.test.mjs
```

`stream.jsonl` 保存消息和可检索任务索引，`tools.jsonl` 保存操作事件，`episodes.jsonl` 保存任务关联，`blobs/` 保存按 SHA-256 寻址的完整工具证据和文件版本。原始工具证据不进入常规检索。`integrity.json` 是当前字节基线，能发现已纳入基线的记录被修改、删除、重排或截去尾部。

旧数据不改写；首次纳入基线不代表过去从未丢失。`verify` 和 `health` 对异常返回非零退出码。合法但未提交的尾部经检查后用 `sync` 接纳；坏 JSON 或旧字节损坏会拒绝接纳。`replay` 按来源 ID 补齐派生记录，重复执行不会重复生成。`compact --apply` 已禁用。

文件快照上限为 8 MiB，超限或不可读会明确标注。仅识别有明确路径的写入工具及 patch 增删改/移动；shell 改文件只有调用结果证据。旧版已截断的内容无法凭空恢复。背景护栏不能保证模型永远保持同一种文风。实现依据、边界和恢复步骤见 [可靠性说明](docs/memory-reliability.md)。

---

## workbuddy-memory（WorkBuddy）

```powershell
cd workbuddy-memory
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会复制 `bin/mem.mjs`、`bin/mem-evidence.mjs` 和 `SKILL.md`，并在 `~/.workbuddy/settings.json` 里挂五个 hook：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`。改前自动备份 settings，已有的无关 hook 原样保留。**要重开一次 WorkBuddy 才生效。**

数据在 `~/.workbuddy/mem/`：`stream.jsonl` 是原文，`blobs/` 是完整工具证据和文件版本，`integrity.json` 是字节基线，`pending.json` 负责跨进程的工具前后配对。默认不截断文本；只有配置显式打开 `truncate` 才按 `capChars` 截。

```bash
M="$HOME/.workbuddy/skills/self-memory/bin/mem.mjs"
node "$M" stats
node "$M" recall "上次那个插件"
node "$M" trace "扫码走局域网"
node "$M" show 12
node "$M" verify
node "$M" health
node "$M" replay
node --test workbuddy-memory/test.mjs
```

## 三个实现怎么对齐

共同原则是：原文只追加、摘要只当索引、完整证据按哈希回查、自动记录不猜原因。差异只在事件模型：

- OpenCode 的 `context` 能改发出副本，所以背景紧挨着最后一条用户消息注入；
- DSH 的 `session/event` 在一个进程里连续到达，工具调用/结果可以用内存 Map 配对；
- WorkBuddy 的每个 hook 都是独立进程，所以配对必须落 `pending.json`。

`verify` 在三个实现里都只保证“接纳基线之后字节没被改/删/重排/截尾”，不证明内容真实，也不证明基线之前没丢过。

---

## 一个有意的不一致

DSH 按工作区**隔离**，OpenCode 用全局库**只过滤**。

不是没统一，是场景不同：DSH 支持「一个文件夹住两个身份」，隔离是功能；OpenCode 只有一个用户，按文件夹切等于每次换项目就失忆。

---

## 出处

`dsh-memory` 是 [dsh-hippocampus](https://github.com/coner13/dsh-hippocampus)（MIT, © coner13）的 fork。

切段、幂律衰减、身份锚、归属规则这些算法来自上游；本仓库的改动：

1. 数据目录改为 `~/.dsh/dsh-memory`，避免和上游冲突
2. 新增 `memory_stats` 工具
3. 每段加 `domain` 分类（chat / study / research / build）
4. 修了 Windows 上的 BOM 问题（配置文件和 PowerShell 脚本）
5. 测试输出改成 ASCII 的 `PASS/FAIL`，方便在 GBK 控制台看

`self-memory` 是照着同一套原则重写的，不共享代码。

---

## 仓库里没有什么

- 没有对话原文、没有记忆库、没有本机路径
- 没有早期语料分析的脚本和数据（含真实对话摘录，见 `.gitignore`）
- 没有 embedding、知识图谱、LLM 抽取

最后一条是刻意的：**先积累真实数据，再决定加什么。**
