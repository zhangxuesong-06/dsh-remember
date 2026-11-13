# 自动记忆的证据与恢复

## 参考实现

本轮对照代码和已有测试后采用的是以下机制，没有运行这些上游项目的完整服务或测试环境，不能据此声称本插件效果已经被上游保证。VTube 不作为验证依据；本轮没有复制这些项目的实现代码。

| 来源与检查版本 | 可复用的机制 | 本地落点 |
|---|---|---|
| [dsh-hippocampus](https://github.com/coner13/dsh-hippocampus/tree/09c332c7445ad8e05deda9542f253e5758acf61e) | 原始记录与检索索引分离，索引可丢失，原文可回查 | 保存完整文本，自动背景只放有界摘录和编号 |
| [ebbingflow 的 CDC 测试](https://github.com/MMX920/ebbingflow/blob/a71e253d59e18f548ee7916393c764f559b89a5a/tests/test_cdc_outbox.py) 与 [事件证据测试](https://github.com/MMX920/ebbingflow/blob/a71e253d59e18f548ee7916393c764f559b89a5a/tests/test_event_evidence_chain.py) | 持久事件、递增版本、事件关联原始消息；处理失败后能够重试 | 先提交工具结果，再生成产物索引；按来源事件 ID 重放去重 |
| [dsh-world memoryStore](https://github.com/chenkezhen480/dsh-world/blob/ce9af0993c8af10a1cb50d33cdbe1b1760a73487/src/memoryStore.ts) | 引用携带来源 ID 与内容哈希；正文变化要能发现 | 保存 SHA-256 对应的前后版本字节，读证据时重新校验 |

OpenCode 接口依据 [V2 服务插件文档](https://opencode.ai/v2/docs/build/plugins/server) 及 2.2.5 的插件声明。`context` 修改发出的副本；`execute.after` 明确区分 completed/error；公开文本结束事件携带消息 ID 和内容序号。

## 数据约定

- 用户与助手的文本原文不截断；保存来源会话、消息 ID、文本序号。相同消息重放按来源去重，相同开头的不同消息分别保存。规范上下文中未完成回复的可见文本也会补记为 observed，不能将其视为完成答复。
- 用户文本以 `prompt` 钩子为主路径：它在消息被接纳时触发，且只触发一次。`session.inbox.enqueued` 只作补充——实测同一会话里直接提交的提示不一定再发该事件，只靠事件会漏掉整句。规范会话上下文不包含用户消息，所以不能用 `context` 回填用户文本。
- 助手文本以文本结束事件为主路径；`context` 补记规范会话里已经可见的文本，包含被中断的回复。流式中间版本只保留首次观察和最终完成两版，不按正文 hash 逐版落盘。
- 工具输入与返回值保存为本地完整 JSON 证据。这里的完整是钩子实际拿到的值；工具或宿主此前截断的内容无法恢复。工具完成不等于测试通过，进程退出码等结论要回看结果正文。
- 明确路径的 write/edit/patch 才自动保存文件前后版本。失败操作记录错误和观察结果，不生成成功产物索引。执行后才加载插件的调用会标成未配对，前版本未知。
- 单文件快照上限 8 MiB。超限、缺失、不可读明确标注。shell、外部编辑器、后台任务的文件变化不推断为已捕获版本。并发外部编辑时快照是观察值，不是文件系统事务。
- 任务记录通过用户消息、助手回答、工具事件和产物 ID 关联；摘要是派生观察，不是发言原文或决策。为什么选某个方案只能回到当时回答核对；没有证据就保持未知。
- 不保存模型隐藏推理。附件本体和完整原始网络响应也不在本轮捕获范围内。

## 校验与恢复

`stream.jsonl`、`tools.jsonl`、`episodes.jsonl`、`marks.jsonl` 只追加。写入采用跨进程锁，先持久化正文，再原子替换检查点；文件证据先写临时文件并同步，再按哈希发布。别名和钉住状态也在锁内原子更新，但它们是可变状态，不属于四个原始账本。

`verify` 检查记录 JSON、已接纳的原始字节、正文哈希和被引用的 blob。能检测中部修改、元数据变化、整行删除、重排、截尾、坏 JSON、缺失或损坏证据。它不证明内容真实、不防同时改写数据和检查点，也不能发现从未到达钩子的事件。旧数据首次建基线只证明从该时刻开始的字节状态；`noHash` 仍单列。

| 状态 | 处理 |
|---|---|
| OK | 当前纳入基线的数据一致 |
| UNTRACKED | 有历史数据尚未建基线；检查来源后执行 `sync` |
| PENDING | 原有前缀一致，但有合法未提交尾部；检查后 `sync` 接纳，再 `replay` 补索引 |
| BAD | 原字节或证据不一致；保留现场，从可信副本恢复到另一个目录检查。`sync` 拒绝损坏的账本字节 |

`sync` 不修复、删除或重写原始记录，也不证明新增尾部来源可信。损坏或失踪的 blob 需要从可信副本补回；重新设置检查点不能修复它。若最后一行写到一半（进程在 `write` 中途退出），`verify` 会显示未接纳尾部，`sync` 会拒绝接纳；先备份整个目录，再人工确认那一行是否完整，不要直接让检查点吞掉它。

`verify` 是只读操作，不抢写锁；写入锁等待上限为 8 秒。若锁的 owner PID 已确认死亡，下一次写入会自动回收该锁；活进程的锁不会被按年龄强拆。2026-11-10 的四天评估里发现旧版 1 秒锁在服务重启、多个工作区实例同时写入时会超时并丢事件（包括一条用户消息），已用“只读校验 + 更长等待 + 死锁回收”修复，并用 6 个并发写入进程在空库和 3 MB 库上做过无丢失压力测试。

进程异常退出可能留下锁。`unlock` 只接受能确认已死亡的 owner PID，拒绝释放活进程的锁；owner 文件缺失/损坏时需人工检查，不自动按时间强拆。检查点失败后也不会自动吞掉尾部继续写。

启动时会重放已落盘的派生事件；`node tools/mem.mjs replay` 可手动补齐。它不能重建从未记录的原始工具结果。连接中断期间未保存的助手原文，只有仍在规范会话上下文中才可自动补记。

桌面服务实测存在模块缓存：仅改变 import 的 URL 参数不能可靠刷新依赖。插件为整套 `mem-*.mjs` 生成内容版本目录后加载，确保依赖来自同一版本；旧目录保留供已发出的请求使用。修改工具源码后要让插件入口重新加载。无需为了这个改动重启服务。

## 验证

```bash
node --test tools/tests/memory.test.mjs
node tools/mem.mjs health
node tools/mem.mjs verify
node tools/eval-recall.mjs            # 真实提问 → 当时回答的召回评测
node tools/eval-recall.mjs --grid     # 对比打分参数
```

测试使用独立临时库，不修改真实记忆。覆盖完整长文本、重复来源、成功/失败操作、前后版本、投影中断重放、损坏检测、合法尾部恢复、并发进程、背景副本、最后回答事件及工作区过滤。

`eval-recall` 只读真实账本，用「用户原话 → 那一轮的回答」做判定：命中算的是 top-k 里有没有当时的回答，不是有没有包含查询词。2026-11-13 的基线（102 条配对，K=8）：

| 打分方式 | hit@1 | hit@8 | MRR | top-8 字符 | 老记录 hit@8 |
|---|---:|---:|---:|---:|---:|
| 时间衰减（旧默认） | 0.549 | 0.814 | 0.650 | 10,280 | 0.790 |
| 新鲜加分（现默认） | 0.657 | 0.892 | 0.742 | 9,247 | 0.889 |
| 完全不加时间 | 0.667 | 0.892 | 0.749 | 8,822 | 0.889 |
| 覆盖率阈值 0.3 | 0.676 | 0.873 | 0.757 | 6,416 | 0.864 |

结论：旧衰减会把 40 天前的记录压到只剩 5%，老话题被永久埋掉；改成「新鲜最多加 1.5 倍」后，老记录命中 +9.9 个点，近三天命中不变。覆盖率 0.3 能再省 30% 字符，但 102 条里有 3 条直接空召回——宁可多给，不假装没有，所以默认仍是 0.2。需要旧行为时传 `rank: { recency: { mode: 'decay' } }`。

## 另外两个 harness

同一套证据原则已经落到 DSH 和 WorkBuddy，但按各自的事件模型改写，不共享运行时代码：

| harness | 完整原文 | 来源去重 | 工具证据 | 产物版本 | 校验/恢复 |
|---|---|---|---|---|---|
| OpenCode | 是 | 消息 ID + 文本序号 | `tools.jsonl` + `blobs/` | 前后 SHA-256 | `verify` / `sync` / `replay` |
| DSH | 是（旧版 6000 字上限已移除） | `sid:seq` / relay gid | `blobs/` + 结果摘要 | 前后 SHA-256 | `cli.mjs verify` / `health` / `sync` / `replay` |
| WorkBuddy | 是（默认不截断） | hook 事件 ID / 消息 ID | `blobs/` + 结果摘要 | 前后 SHA-256 | `mem.mjs verify` / `health` / `sync` / `replay` |

DSH 的 `session/event` 在同一进程连续到达，调用/结果用内存 Map 配对；进程重启会丢掉配对，此时结果仍落盘，但前版本标 `unknown`。WorkBuddy 每个 hook 是独立进程，所以配对写在 `pending.json`，超过 6 小时未配对的条目会被清掉。

两个实现都保留“旧数据不改写”：首次 `sync` 只建立当前基线，`noHash` / `UNTRACKED` 会明确显示；`dedup` / `compact --apply` 不再改写原始账本。已用隔离临时库验证长文本、来源去重、成功/失败写入、前后版本、篡改/删行/截尾检测、合法尾部接纳和重放幂等。DSH 原有 `selftest` 100/100、`smoke` 59/59 仍通过；WorkBuddy 新增测试 13/13 通过。实机只做了只读打开、`sync` 建基线和 `verify`/`health`，没有伪造真实会话做端到端召回测试。

## Token 与维护

OpenCode 的 `context` 钩子原来每次模型调用都注入约 976 字符（约 680–980 tokens）。现在：

- 每回合首次注入约 400–600 字符；
- 同一回合的工具续调只注入 40–80 字符的编号指针；
- `mem.recall` 每次返回约 420 字符摘录，完整原文用 `mem_read`；
- `MEMORY_COMPACT_REPEAT=0` 可关闭续调紧凑模式。

这些是输入 token，不增加模型调用次数；稳定前缀仍可被上下文缓存命中。

维护只由插件/软件触发：OpenCode 在 `setupMemory`、DSH 在 `apply`、WorkBuddy 在 `SessionStart` 以 detached 子进程运行 `--due`，多个工作区实例用锁和 `maintenance.json.lastRun` 收敛；默认 12 小时一次，`MEM_MAINTENANCE_INTERVAL_HOURS=0` / `DSH_MAINTENANCE_INTERVAL_HOURS=0` / `WORKBUDDY_MAINTENANCE_INTERVAL_HOURS=0` 可改为每次打开 harness 尝试。没有注册 Windows 计划任务。

`--backup` 复制 JSONL 与 `integrity.json`，blob 用同盘硬链接，因此快照几乎不额外占空间；默认保留 14 份。`--prune` 默认只试算，只清“未被任何记录引用且超过 30 天”的 blob；原始账本永不自动删除。`--verify` 写 `maintenance.json`，异常时退出码 1。

WorkBuddy 另有一层 SQLite FTS5 派生索引（`index.db`）。它只加速 hook 的检索：`SessionStart` 读 episode 元数据，`UserPromptSubmit` 先用 FTS 找候选；索引缺失、构建中、落后于 stream 或写入失败时自动回退到原来的全量读取。每次 append 增量更新索引，`SessionStart` 在索引超过 24 小时或 `meta.bytes` 与 `stream.jsonl` 大小不一致时后台重建；`index.db` 可随时删除，`stream.jsonl` 仍是唯一真相。50k 条合成数据上，hook 走索引约 195ms，全量回退约 440ms；主要固定成本仍是 Node 启动。
