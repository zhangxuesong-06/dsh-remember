# agent-memory

给 agent 用的长期记忆。两个插件，一套共用的存储与检索。

| 目录 | 是什么 | 装在哪 |
|---|---|---|
| `dsh-memory/` | DSH 插件：按工作区隔离，挂 `session/event` 自动落盘 | `~/.dsh/profiles/node_modules/` |
| `plugin/self-memory/` | OpenCode 插件：全局一个库，挂 `prompt` / `context` / `compaction` 钩子 | 全局 `opencode.json` 的 `plugins` |
| `tools/` | 存储与检索（CLI 和 OpenCode 插件共用） | — |

两个插件都能**不靠模型自觉**地记录：消息发生时就落盘，不是等模型想起来调工具。

---

## 共同的三条原则

1. **记录不经过模型。** 挂钩子，事件发生时直接追加。模型一忙就会漏，漏了那段就不存在。
2. **摘要只当索引。** 每轮只给「这事你以前碰过」的编号和日期；要细节就翻原话。
3. **真相永远回原文。** `trace` 按字查，一字不差，结果分「他说的 / 我转发的 / 我说的 / 工具」。承诺和归属只认它。

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

三个钩子：`prompt` 记用户消息，`context` 补记助手消息并注入醒来块，`compaction` 记一笔。
三个工具：`recall` / `trace` / `remember`，外加 `map` 和 `alias`。

数据在 `~/.opencode-mem/`，**全局一个库**，每条带 `ws` 标签——换文件夹不该等于换一个人。

CLI 兜底：

```bash
node tools/mem.mjs brief
node tools/mem.mjs recall "分块多大"
node tools/mem.mjs trace "扫码走局域网"
node tools/mem.mjs add "结论" --kind decision
```

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
