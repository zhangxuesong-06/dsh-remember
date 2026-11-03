# dsh-memory

给 DSH 用的长期记忆插件。**模型不用记得去记**——每句话自动落盘，需要时按线索翻出来。

基于 [dsh-hippocampus](https://github.com/coner13/dsh-hippocampus)（MIT, © coner13）改造，加了用途分类和记忆库概览工具。

---

## 它做什么

| 层 | 是什么 | 谁负责 |
|---|---|---|
| **流** | 每句话、每次动手，发生时就追加到 `stream.jsonl` | 插件（不经过模型） |
| **段** | 按「一次见面 / 一件事」切开，只挂标题和编号 | 插件 |
| **线索** | 每轮最多 3 行「这事你以前碰过」，只给编号和日期 | 插件 |
| **锚** | 从你自己说过的话里挑 4 句，放系统提示区，整场冻结 | 插件 |

**摘要只当索引，不当内容。** `recall` 返回的永远是当时的原话，带会话号和行号。

---

## 装

```powershell
cd <这个目录>
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Workspace "D:\你的工作区"
```

然后：

1. 打开 `%USERPROFILE%\.dsh\dsh-memory\config.json`，确认 `workspaces` 是你的工作区绝对路径
2. 重启 DSH

零依赖，不需要 `npm install`。

**卸载：**

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

记忆数据留在 `~/.dsh/dsh-memory/`，不会被删。

---

## 用

装好之后有四个工具，模型会自己调：

| 工具 | 干什么 |
|---|---|
| `recall` | 按一句话 / 日期 / 段号，翻出**原话** |
| `trace` | **按字**查，一字不差；结果分「他说的 / 他转发的 / 我说的 / 只是操作」 |
| `remember` | 特意记下，不让它变淡（承诺、稳定信息） |
| `memory_stats` | 看一眼库：多少句、多少段、多大、最近几段 |

**`recall` 管意思，`trace` 管归属。** 问「你是不是答应过我」只认 `trace` 里「他说的」那一类。

---

## 怎么确认它在工作

1. 新开一个会话，问：「看看记忆库现在什么样」→ 应该调 `memory_stats`
2. 或者看 `%USERPROFILE%\.dsh\dsh-memory\diag.log`，最后几行应该有 `挂上 <会话>` 和 `预激活 ...`
3. 聊几句之后再看 `memory_stats`，`记录` 和 `段` 的数字应该在涨

**数字不涨** → 八成是 `workspaces` 没填对，或者 `enabled` 是 false。

---

## 数据在哪

```
~/.dsh/dsh-memory/
├─ config.json
├─ diag.log                      诊断
└─ <工作区名>-<哈希>/
   ├─ stream.jsonl               只增不改的原始记录（真相）
   ├─ state.json                 索引缓存（删了会重建，不丢数据）
   └─ marks.jsonl                remember 写下的
```

**备份**：复制整个 `~/.dsh/dsh-memory/`。
**清空某条线**：删掉那个工作区目录。
**换机器**：把整个目录拷过去，改一下 `config.json` 里的路径。

---

## 已知限制

- 检索是**词法**的（BM25 + 中文 bigram），不懂同义词。「电脑」不一定搜得到「笔记本」。
- 段号会随规则升级重排，`recall #N` 里的 N 可能变。原话不变。
- 不做知识图谱、不做 embedding、不调模型。这是刻意的：先积累真实数据，再决定加什么。

---

## 和上游的关系

算法（切段、幂律衰减、锚、归属规则）来自 dsh-hippocampus，MIT 协议。
本仓库的改动：

1. 数据目录改为 `~/.dsh/dsh-memory`（避免和上游冲突）
2. 新增 `memory_stats` 工具
3. 每段加 `domain` 分类（chat / study / research / build）
4. 测试输出改成 ASCII 的 `PASS/FAIL`，方便在 GBK 控制台看

上游版权声明保留在 `LICENSE`。
