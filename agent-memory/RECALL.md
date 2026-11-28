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

## 案例短条目试验

五端在原事件落盘后，用共用规则生成工具观察、显式决定、约束、纠正和任务短条目。打开 `MEMORY_CASE_RECALL=manual` 后，轮次或工具收尾的后台同步会更新派生索引。查询直接读取已存条目。含 `case:` 的引用定位源行，支持 `--range start:end` 逐字回读，偏移为 UTF-16 零基且末端不计入。长证据默认返回前 12,000 个 UTF-16 码元以内的完整字符，并附下一段范围 `next` 和总长度 `total`。`observed` 表示已观察到的记录，`verified` 当前限于符合版本与退出码校验的 OpenCode 单项 Node TAP 回归。缺少真实轮次的用户原话可以保留为独立观察。

| 宿主 | 查询和回读 |
| --- | --- |
| OpenCode | `node tools/mem.mjs recall "export_id" --cases`，`node tools/mem.mjs show "<case 引用>"`。模型使用 `mem.recall` 的 `cases: true` 和 `mem.read`。 |
| Codex | `node agent-memory/recall.mjs recall "export_id" --cases`，`node agent-memory/recall.mjs show "<case 引用>"`。 |
| DSH | 当前账本的 `memory_recall` 传 `cases: true`，`memory_read` 传引用。CLI 使用 `node dsh-memory/cli.mjs recall "<工作区>" "export_id" --cases`。 |
| WorkBuddy | `node workbuddy-memory/bin/mem.mjs recall "export_id" --cases`，同脚本 `show "<case 引用>"`。 |
| ZCode | `node zcode-memory/bin/cli.mjs recall "export_id" --cases`，同脚本 `show "<case 引用>"`。MCP 也支持 `cases: true` 和引用回读。 |

运行命令时，当前目录决定项目范围，DSH 沿用已选择的账本。旧 WorkBuddy 记录若只有目录末段，可通过旧召回查找。默认返回三条，最多五条，JSON 上限为 3,072 UTF-8 字节。索引需要 SQLite 和 FTS5，`unavailable` 或 `stale` 时可用原有 `recall`、`trace` 和 `show`。

共享 CLI 的 `--source` 可指向显式登记的别名。`MEMORY_CASE_SOURCES` 接收 JSON，例如 `{"old":{"adapter":"opencode","root":"C:/isolated/ledger","project":"C:/isolated/previous","fromProject":"C:/isolated/current"}}`。在 `fromProject` 用 `recall "export_id" --cases --source old` 查询，并用 `show "<case 引用>" --source old` 回读。撤去别名即撤回后续访问。DSH 别名的 `root` 指单独的工作区或身份线账本。

OpenCode 的 `auto` 是试验开关。插件只在当前项目根的任务开始或读到测试锚点后查找已验证案例。匹配要求测试路径、名称和当前测试文件版本一致。首次可能写入后跳过首次提示。同轮规范历史出现新的已完成压缩记录时，复核原证据后允许补发同一条。每次提示最多 512 UTF-8 字节，每轮合计最多 1,536 字节。

用 `node agent-memory/probe-opencode-cases.mjs "<OpenCode CLI 的绝对路径>"` 检查隔离宿主的失败与通过证据、首次写入前的提示、先写后读保持静默和原文回读。加 `--compact` 检查连续两次压缩，每次完成后同一提示补发一次。

`--full-task` 用脚本化提供方验证读取当前配置、修改合成文件和运行测试的整条路径。`--ollama "<本机已安装的模型>" --full-task` 在回环 Ollama 上以同一合成快照运行现有召回、手动短条目和自动提示三组。省略 `--full-task` 时，Ollama 模式运行只读诊断。每组记录实际模型请求、工具调用、提示是否到达、修改前是否核对当前配置、最终文件和独立测试结果。工具调用与测试结果取自宿主证据及本机复跑。三组都使用直接工具定义，所有探针使用临时配置、账本和项目。单题结果用于诊断，正式三组对照规则见下文。

Windows 上加 `--steady 6` 可用同一个探针测试常驻 `opencode serve`。三轮轮换组序，每组启动独立的隔离服务，预热一个任务后连续测五个任务。手动组实际调用短条目查询与逐字回读，自动组核对首次写入前的送达。`maxSampledWorkingSet` 是预热后工作集采样最大值，`peakWorkingSet` 是 Windows 记录的进程寿命峰值，可能包含预热。维护进程、CLI 客户端和模型提供方的内存不计入宿主数据。这个模式使用脚本化提供方。

OpenCode 可用 `node tools/mem-maintenance.mjs --root "<账本目录>" --case-index-sync` 或 `--case-index-rebuild` 维护案例索引。其余四端在上述 CLI 使用 `case-index-sync` 或 `case-index-rebuild`，DSH 在命令后附工作区。升级 v3 后从源账本生成新版索引，首次回填期间可能返回 `unavailable` 或 `stale`。v2 派生文件留给旧版回退，原有 `case:` 引用可以继续回读。关闭试验时设 `MEMORY_CASE_RECALL=off` 或清除这个变量。日常原文查询仍可访问源账本。

### 三组模型对照

`node agent-memory/eval-cases.mjs --check` 验证规则命中。用 `node agent-memory/eval-cases.mjs --check --input "<模型试验结果.json>"` 校验整题对照。输入为 `{"runs":[...]}`。每条运行记录填写下表字段。

| 字段 | 取值 |
| --- | --- |
| `scenario`、`repetition` | `fixtures/memory-cases.json` 留出集中的场景 ID，每个场景至少做第 1、2、3 次 |
| `mode` | `baseline` 为已有召回，`manual` 为已存短条目，`auto` 为自动提示加手动入口 |
| `model`、`snapshot` | 每个配对试验使用相同模型和同一仓库快照 |
| `correctReuse`、`wrongReuse`、`testPassed` | 布尔值，记录修改前是否正确复用、是否误用，以及最终测试是否通过 |
| `outOfScope`、`exactEvidence` | 布尔值，记录是否出现越界提示以及实际回读的引用是否逐字一致 |
| `inputTokens` | 此次任务的实际输入 token 总量，包含重复上下文 |

报告汇总三组的复用、失败和 token 指标。自动组相对手动组须提升至少 15 个百分点，误用和测试失败不得增加，平均输入 token 至多与两对照组持平，p95 至多为原召回组的 105%。全部记录须满足作用域和证据要求。宿主送达及安装资源仍需各自验收。

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
node agent-memory/recall.mjs recall "长回复中的线索" --rank long-text
node agent-memory/recall.mjs recall "记得的原文关键词" --rank passage --compact -n 3
node agent-memory/recall.mjs trace "扫码走局域网"
node agent-memory/recall.mjs show dsh:812
```

引用格式是 `source:line`；DSH 多工作区时是 `dsh:<工作区>:<line>`。JSONL 只追加，所以行号稳定。

`recall` 和 `trace` 的 `--compact` 返回一个 JSON 数组。每条含角色、完整来源引用及命中处的原文摘录。最多 5 条，每条正文最多 192 个 UTF-16 码元，整个序列化输出最多 3,072 个 UTF-8 字节。按返回的 `ref`、`start` 和 `end` 调用 `show "<ref>" --range <start>:<end> --json` 可复核原文。位置从 0 开始，末尾不计入，和 JavaScript `String.slice` 一致。需要全文时用 `show "<ref>"`。

## 打分

和 OpenCode 的 `recall` 保持一致：

```text
BM25(K1=1.25, B=0.72) × 新鲜加分 × 类别权重
新鲜加分 = 1 + 0.5 × 0.5^(天数/3)
覆盖率阈值 0.2
```

`--rank long-text` 把 BM25 的长度归一化参数 `b` 从默认的 0.72 降到 0.45，减轻长记录的排序惩罚。搜索结果继续带完整原文引用。用 `--rank default` 可按默认参数查询。

`--rank passage` 适合记得具体措辞的查询。它按 640 个 UTF-16 码元、重叠 128 个码元切分原文，每条记录用最相关的段落参与排名。段落索引按需在内存中创建。长段落结果按完整正文折叠，同一记录只返回一次。

类别权重：普通记录 1.0 · artifact 0.85 · episode 0.55 · meta 会话标题 0.4 · 工具行 0.35。

去重只作用于结果视图：

- 长文本按正文前 120 字折叠，跨会话也折叠（每日重复模板只占一个位置）；
- 短文本保留 sid 区分；
- 跨库不合并，同一件事在两个库各记一份就保留两条并标来源。

## 验收

### 五端合成召回基线

```bash
node agent-memory/eval-recall.mjs
node agent-memory/eval-recall.mjs --json
node agent-memory/eval-recall.mjs --check
```

评测用固定时钟和临时账本，从五个来源一起召回。题目给出改述问句和人工指定的原文引用。工具按引用核对完整正文、角色、会话和已有的轮次标识，再按目标在结果里的位置计算 Hit@3 和 MRR@8。排行与原文回读分开记录。没有可靠轮次标识的旧格式仍按明确的原文引用评分。

`--json` 输出逐题的来源、排名、原文回读结果和候选记录。 `--check` 与 `fixtures/recall-baseline.json` 比较，题目变更、结果变动或原文回读异常时以退出码 1 报出题号。基线保留一条已知的改述漏召回题，便于比较后续改动。输入都来自 `fixtures/recall-cases.json`，真实库评测另行运行。

### 本机账本调参

```bash
node agent-memory/eval-live.mjs
node agent-memory/eval-live.mjs --at "2026-11-21T12:00:00+08:00"
```

脚本只读当前账本，复用整条索引比较默认排序与覆盖率、长度归一化和新鲜度的候选参数，并另建分段索引测试 `passage`。按来源把较早会话放入调参组，较晚会话放入留出组。每个会话的每类题最多抽 12 道。输出包含总体和分来源计数、命中率、MRR@8 和空结果数。原文线索另测目标是否进入前八条及其返回摘录是否包含线索，涵盖长文后半段取样。

回答题用原始提问找有明确轮次归属的助手回复，查询时排除重复的提问原文。短线索题从原文截取较短片段，按完整来源引用判定命中。两种题衡量有词面线索时的表现，改述召回仍使用上面的固定评测。`--at` 固定新鲜度计算的时间。账本继续追加后，样本和结果可能变化。

### 历史记录

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
