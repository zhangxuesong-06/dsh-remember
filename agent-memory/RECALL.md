# 跨 harness 只读查询

目标：在任意一个 harness 里也能找到其它 harness 里做过的事，但不合并各自的库。

## 边界

- 只读：`readFileSync` / `statSync` / `readdirSync`，不建目录、不拿锁、不写缓存；
- 不 import `mem-core` / `mem-journal`；分词来自独立的 `mem-tokenize.mjs`；
- 每个库各自仍是唯一真相，结果只标 `opencode` / `dsh` / `workbuddy` / `zcode` / `codex`；
- 不自动注入到每次对话，按需调用。

## 数据源

共享布局（迁移后）：

```text
~/.agent-memory/
  manifest.json
  opencode/stream.jsonl
  dsh/<工作区>/stream.jsonl
  workbuddy/stream.jsonl
  zcode/stream.jsonl
  codex/stream.jsonl
```

迁移前或显式设置环境变量时，回退到旧布局：

| 来源 | 共享路径 | 旧路径 |
|---|---|---|
| OpenCode | `~/.agent-memory/opencode/stream.jsonl` | `OPENCODE_MEM_HOME` 或 `~/.opencode-mem/stream.jsonl` |
| DSH | `~/.agent-memory/dsh/<工作区>/stream.jsonl` | `DSH_HOME/dsh-memory/<工作区>/stream.jsonl` |
| WorkBuddy | `~/.agent-memory/workbuddy/stream.jsonl` | `WORKBUDDY_MEM_HOME` 或 `~/.workbuddy/mem/stream.jsonl` |
| ZCode | `~/.agent-memory/zcode/stream.jsonl` | `ZCODE_MEM_HOME` 或 `~/.zcode/memory/stream.jsonl` |
| Codex | `~/.agent-memory/codex/stream.jsonl` | `CODEX_MEMORY_HOME` |

DSH 和 WorkBuddy 的流里九成是 `tool/call` / `tool/result`。默认只收对话、笔记、决策、段落、产物；工具行用 `--with-tools` 显式打开。

## 捕获完整性

```bash
node agent-memory/coverage.mjs                 # 五端一张表
node agent-memory/coverage.mjs --source zcode
node agent-memory/coverage.mjs --since 7d
node agent-memory/coverage.mjs --worst         # 列出缺得最多的会话和引用行号
```

口径：

- `turns`：用户消息数（一次提问算一轮）。
- `missing`：这一轮和下一条用户消息之间没有助手记录（严格口径）。
- `followup`：`missing` 里后面还有回答的——用户连发几条，回答合并到了下一轮，不算丢。
- `silent`：整场会话后面再也没有任何助手记录，这才是硬缺口。
- `eff`：`(answered + followup) / turns`，用来判断“是否系统性丢回答”。
- `noResult`：工具调用没有对应结果；OpenCode 的工具在 `tools.jsonl`，这里恒为 0。

ZCode 的硬缺口可以用回填补：

```bash
node zcode-memory/bin/cli.mjs backfill --dry-run
node zcode-memory/bin/cli.mjs backfill
node zcode-memory/bin/cli.mjs maint verify
```

回填只读 ZCode 的 `db.sqlite`，按时间窗取该轮最后一条 assistant 正文，幂等；找不到正文的轮只计数。
子代理的证据链用 `backfill --subagents` 单独补（任务提示标 `meta`，不写模型间对话）。

DSH 的回填同时支持 `session.v4.jsonl.zstd` 和旧格式 `session.jsonl.zstd`；两个都在时优先 v4。
DSH 子代理只补证据链（任务提示标 `meta`，工具/产物保留，模型间对话不写）。

## 迁移

```bash
node agent-memory/migrate.mjs            # dry-run，只出计划
node agent-memory/migrate.mjs --apply    # 关闭三个 harness 后执行
node agent-memory/migrate.mjs --sync     # 已迁移后接上旧库新增的尾部
```

也可以直接双击 `agent-memory\activate.cmd`：它会结束 OpenCode 和 `opencode-cli`，再自动选择 `--apply` 或 `--sync`，最后验证并写 `~/.agent-memory/activation.log`。

- 先写 staging，校验文件数和大小后原子改名；
- 只复制，不移动；旧目录原样保留；
- `runtime`、`snapshots`、`assoc.json`、`index.db` 不搬，可重建；
- 复制过程中源库有写入就中止，要求先关闭 harness；
- 回退：切换后还没有新记录时，删除 `~/.agent-memory`，三个写入端自动回到旧路径；一旦共享库开始写入，先把共享流复制回旧路径再删。

## 命令

```bash
node agent-memory/recall.mjs sources
node agent-memory/recall.mjs recall "kgnav 孤岛" -n 8
node agent-memory/recall.mjs recall "题库" --source workbuddy --since 30d
node agent-memory/recall.mjs recall "派生索引" --with-tools --json
node agent-memory/recall.mjs trace "扫码走局域网"
node agent-memory/recall.mjs show dsh:812
```

引用格式是 `source:line`；DSH 多工作区时是 `dsh:<工作区>:<line>`。JSONL 只追加，所以行号稳定。

## 打分

和 OpenCode 的 `recall` 保持一致：

```text
BM25(K1=1.25, B=0.72) × 新鲜加分 × 类别权重
新鲜加分 = 1 + 0.5 × 0.5^(天数/3)
覆盖率阈值 0.2
```

类别权重：普通记录 1.0 · artifact 0.85 · episode 0.55 · meta 会话标题 0.4 · 工具行 0.35。

去重只作用于结果视图：

- 长文本按正文前 120 字折叠，跨会话也折叠（每日重复模板只占一个位置）；
- 短文本保留 sid 区分；
- 跨库不合并，同一件事在两个库各记一份就保留两条并标来源。

## 验收

2026-11-14 实测：

```text
OpenCode 2,657 条 · DSH 1,077 条（对话 191）· WorkBuddy 1,145 条（对话 109）
单次查询        85–110 ms
六次查询冷启动  535 ms
测试            13 / 13
只读断言        三个 stream.jsonl 哈希与目录列表运行前后一致
```

## 限制

- 不做跨库别名扩展和语义检索；
- 不自动注入，避免每轮对话背三个库的开销；
- DSH 的工作区隔离仍然保留，只在结果里标出目录名。
