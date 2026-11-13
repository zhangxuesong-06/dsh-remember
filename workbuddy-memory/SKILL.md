---
name: self-memory
description: 我自己的长期记忆库——跨会话记住用户说过的话、我做过的决定和交付过的东西。当用户问「你以前是不是说过…」「上次那个插件叫什么」「我们之前怎么定的」，或需要核对历史细节、接着上次的活干时使用。写入由 WorkBuddy 的 hook 自动完成，不靠我自觉。
agent_created: true
---

# self-memory：我自己的记忆

## 它是什么

一套独立实现的记忆系统，数据全在本地，不依赖任何别的程序：

| 层 | 是什么 | 谁负责 |
|---|---|---|
| **流** | `~/.workbuddy/mem/stream.jsonl`，一条一行、只增不改，每条带 `ws`（哪个工作区） | hook（不经过我） |
| **证据** | `blobs/` 按 SHA-256 保存完整工具输出和文件前后版本；`integrity.json` 记录当前基线 | 脚本 |
| **段** | 按「一次见面 / 一件事」切，只留标题和编号 | 脚本 |
| **线索** | 每轮最多 3 行「这事你以前碰过」，只给段号和日期 | 脚本，注入到上下文 |
| **锚** | 醒来时给最近几段 + 怎么翻 | 脚本（SessionStart） |

**摘要是索引，不是内容。** `recall` 返回的永远是当时说的原话，带行号；要完整原文、工具结果或文件版本，用 `show`。

## 写入是怎么来的（不靠自觉）

`~/.workbuddy/settings.json` 里挂了五个 hook，都指向 `bin/mem.mjs hook`：

| 事件 | 记什么 |
|---|---|
| `SessionStart` | 不记，**输出**「醒来块」注入上下文 |
| `UserPromptSubmit` | 记用户这句话；顺手算 0–3 行线索 |
| `PreToolUse`（Bash/Write/Edit/MultiEdit/NotebookEdit） | 记调用、完整入参证据；写入类先存文件前版本 |
| `PostToolUse`（同一组） | 记完整结果/错误；成功写入存后版本并生成产物索引 |
| `Stop` | 记我最后说的那段话（完整，不截断） |

所以「模型忘了写」这件事不存在。改完 settings 不热加载，**要重开一次 WorkBuddy 才生效**。

## 什么时候必须主动翻

- 用户提到过去：「上次」「之前」「还记得吗」「你答应过」→ `recall`，别凭印象答。
- 要核实某句原话是谁说的、说没说 → `trace`（按字查，一字不差）。
- 接着上一个会话的活干 → `arrive` 看最近几段，再 `recall #N` 拿原话。
- 用户说「记住这个」→ `remember`，写进 `marks.jsonl`，醒来时会带上。

## 命令

```bash
M="C:/Users/HUAWEI/.workbuddy/skills/self-memory/bin/mem.mjs"

node "$M" arrive                      # 醒来：最近几段 + 出口
node "$M" stats                       # 规模 / 跨度 / 最近几段
node "$M" episodes 20                 # 段列表（带 #段号）
node "$M" recall 手机远程控制           # 按意思回想，按段聚合给原话
node "$M" recall "#7"                 # 唤醒整段原文（时间顺序）
node "$M" recall 2026-11-03           # 那天有哪些段
node "$M" trace 扫码走局域网            # 按字查：谁说的、第几行
node "$M" remember "用户偏好 X" --key pref
node "$M" ws                         # 各工作区各记了多少
node "$M" dump 20                     # 最近 20 条原始记录
node "$M" show 12                     # 第 12 行的完整原文/来源/版本
node "$M" show <64位哈希>              # 读完整工具输出或文件版本
node "$M" verify                      # 校验已接纳字节、正文指纹和证据
node "$M" health                      # 一行体检
node "$M" sync                        # 检查后接纳历史基线/合法尾部
node "$M" replay                      # 从工具结果补齐缺失的产物索引
node "$M" maintenance --due            # 校验 + 快照；SessionStart 会自动尝试
node "$M" maintenance --backup
node "$M" maintenance --verify
node "$M" maintenance --prune          # 默认只试算
node "$M" index build                  # 重建 SQLite FTS 派生索引
```

`SessionStart` 会以 detached 子进程运行 `mem-maintenance --due`，默认 12 小时一次；不注册 Windows 计划任务。快照存 `~/.workbuddy/mem/snapshots/`，JSONL 复制、blob 硬链接，默认保留 14 份；`--prune` 只清未被引用且超过 30 天的 blob。

检索优先用 `~/.workbuddy/mem/index.db`（SQLite FTS5）：
- `index.db` 是派生层，删了可重建，`stream.jsonl` 仍是唯一真相；
- 索引缺失或写入失败时，hook 自动回退到原来的全量读取；
- 每次追加会增量更新索引，不需要每个 hook 重读全库；
- 新增记录先归属到最近一段，定期重建索引会重新切段。

参数：`--ws <工作区子串>` 只看某个工作区、`--limit n`、`--full` 不截断。

## 读输出

- `行3` = `stream.jsonl` 第 3 行，是原文位置的唯一凭据，可复核。
- `#1` = 段号，按时间追加编号，稳定（流只增不改，编号不会漂）。
- 归属分四类：**用户说的 / 我说的 / 用户贴回的（转发）/ 只是操作**。回答「他说过吗」只认前两类，别把工具调用当成话。
- 段里「（动作：Write → Bash×2）」是折叠过的动手记录，不是对话。

## 边界

- 检索是**词法**的（BM25 + 中文 bigram），不懂同义词：「电脑」不一定搜得到「笔记本」。
- `trace` 至少 3 个字；查不到就是查不到，不会返回「最像的几条」。
- 只记文本：图片、附件内容不进库。
- 一个库管所有工作区，靠 `ws` 区分——换个文件夹问旧事也翻得到，这是刻意的。
- 数据在本地明文，含用户原话。别把它整份粘进对话或外发。
- 备份 = 复制整个 `~/.workbuddy/mem/`；清空 = 删 `stream.jsonl`（存档先改名）。
- 调参看 `~/.workbuddy/mem/config.json`：`captureTools`、`truncate`（默认关）、`capChars`、`primeMax`、`primeMaxDf`、`primeFreshMin`、`recency`。
- 文件版本只覆盖有明确路径的写入工具；shell 改文件只有调用和结果证据。单文件快照上限 8 MiB，超限会标 `oversize`。
- `verify` 的 OK 只证明“接纳基线之后字节没被改/删/重排/截尾”，不证明内容真实，也不证明基线之前没丢过。`sync` 不修复坏字节。
- `diag.log` 里是 hook 失败记录；如果「数字不涨」，先看它。
