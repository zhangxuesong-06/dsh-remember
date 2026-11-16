# 记忆项目 · AGENTS.md

给 agent 做长期记忆。DSH 用的插件在 `dsh-memory/`；**我自己用的在 `plugin/self-memory/`**（装在全局 `~/.config/opencode/opencode.json`，所以所有工作区都会记）。

## 各 harness 的工作报告约定

- 开工先读本仓库 `HANDOFF.md` 的“最新工作报告”，并核对实际目录、分支和 Git 状态；旧报告中的“当前”及测试数字仅代表记录时的状态。
- 完成代码、配置、测试或接口改动后，更新 `HANDOFF.md`：日期、改动、实际执行的验证命令和结果、未验证项、待办及提交或部署状态。
- `HANDOFF.md` 是各 harness 共用的本地工作报告，已配置 `.gitignore`；仍被跟踪时，须先用 `git rm --cached -- HANDOFF.md` 取消跟踪并保留本地文件。持续维护但不提交报告正文，不要用 `git add -f` 强行加入。`AGENTS.md` 继续作为版本管理中的项目协作规则。
- 修改与 kgnav 的接口时，同时更新对方的 `kgnav-handoff.md`；无法同步时明确记录待办，不声称已经完成。
- 有效项目目录为 `C:\Users\HUAWEI\Desktop\work\记忆` 和 `D:\DSH WorkSpace\tool\kgnav`。旧临时工作树已作废，不再写入代码或报告；不能因原始目录无权限就换回旧工作树交付。
- 各 harness 接手后都应持续维护报告。源码、导出快照与已安装副本分别核对，不把源码更新或文档提醒当作已经部署或通知了运行中的其他会话。
- 本次方法词表任务只用合成数据验证。更新工作报告不需要读取、写入或提交私人记忆，也不因此调用真实记忆库的维护命令。

## 记忆是自动的

插件挂事件和钩子，不靠我"记得去记"：

| 钩子 | 干什么 |
|---|---|
| `prompt` / 用户入箱事件 | 保存已接纳的用户文本；`prompt` 是主路径，入箱事件作补充 |
| 文本结束事件 / `context` | 保存助手完整文本；`context` 从规范会话补记可见文本（中断回复标观察值） |
| `context` | 每次模型续调注入有界背景副本，只改发出副本，不落历史 |
| 工具 before / after | 保存调用与结果证据，成功后关联产物前后版本 |
| idle / 执行结束事件 | 自动关联任务、原话、操作结果与产物；不推断原因 |
| `compaction` | 补记可用原文，并标注压缩请求 |

数据在 `~/.opencode-mem/`（全局一个库，`ws` 标签只做过滤，不做隔离）。

原文、执行证据和任务关联自动记录；任务摘要只陈述观察到的事实。判断、结论、待办仍可显式写，必须能回指证据，不能从文件改动猜原因。

## 收工时写一条

```bash
node tools/mem.mjs add "结论一句话" --kind decision --tag segmentation
```

- `--kind`：`decision` / `finding` / `todo` / `data` / `note`
- 只写**这一轮新产生的判断**，别复述已经记过的

长期不变的用：

```bash
node tools/mem.mjs pin constraint "单人使用，本地运行"
```

## 怎么查

```bash
node tools/mem.mjs brief              # 钉住的 + 最近 8 条
node tools/mem.mjs map                # 库里有哪些主题、各多少条
node tools/mem.mjs recall "分块多大"   # 按意思，返回原话
node tools/mem.mjs recall "docker" --scope build/docker   # 先缩范围再查
node tools/mem.mjs trace "扫码走局域网" # 按字，一字不差
node tools/mem.mjs alias vmware "虚拟机,vm"   # 加同义词，跨过词面差异
node tools/mem.mjs toolstats          # 工具调用收集了多少（原始，不进检索）
node tools/mem.mjs assoc build        # 重建联想图
node tools/mem.mjs verify             # 对账：正文有没有被改过（异常时退出码 1）
node tools/mem.mjs health             # 一行体检，出问题一眼看见
node tools/mem.mjs show 123           # 按编号回看原文、来源和版本证据
node tools/mem.mjs replay             # 重放持久事件，补齐缺失的派生记录
node tools/mem.mjs sync               # 检查后接纳历史基线/合法尾部，不修复损坏数据
node --test tools/tests/memory.test.mjs # 使用独立临时目录测试
```

会话里也有 `mem` 工具：`recall` / `read` / `trace` / `remember` / `map` / `alias`。

## 维护与 token

```bash
node tools/mem-maintenance.mjs --root ~/.opencode-mem --due   # 插件启动时自动触发
node tools/mem-maintenance.mjs --root ~/.opencode-mem --backup
node tools/mem-maintenance.mjs --root ~/.opencode-mem --verify
node tools/mem-maintenance.mjs --root ~/.opencode-mem --prune # 默认只试算
```

- 默认 12 小时一次；`MEM_MAINTENANCE_INTERVAL_HOURS=0` 改为每次打开 harness 尝试。
- 快照 JSONL 复制、blob 硬链接，默认保留 14 份；原始账本不自动删。
- `MEMORY_COMPACT_REPEAT=0` 关闭工具续调的紧凑注入。

**分工**：`recall` 找线索，`read` 取证据，`trace` 按字核对消息角色。承诺要回看原文及引用上下文；系统派生记录不能当作用户或助手发言。

**地图是视图，不是存储。** `map` 每次从 facet 现算，删了不影响任何数据；
结构不可写，只有别名可写——别名错了是局部影响，结构错了是全局失明。

## 硬规则

1. `~/.opencode-mem/stream.jsonl` **只追加，不手改**。
2. **摘要只当索引**。写结论时，要能说清它是从哪段原文推出来的。
3. 不确定的写「待验证」，不要写成结论——错的东西一旦进库，会被反复强化。
4. `compact --apply` 已禁用。`verify` 的 OK 只涵盖接纳基线后的字节完整性，不证明此前从未丢失、也不证明模型说法正确。

## 目录

```
agent-memory/                    通用安装/识别层（选 adapter，含给模型看的 INSTALL.md）
plugin/self-memory/              我自己用的 OpenCode 记忆插件（钩子 + 工具）
workbuddy-memory/                WorkBuddy 记忆 skill（hook + 单文件脚本）
zcode-memory/                    ZCode 记忆插件（6 个钩子 + 常驻 MCP，写共享库）
tools/mem-core.mjs               OpenCode 的存储与检索（CLI 和插件共用）
tools/mem.mjs                    OpenCode CLI
dsh-memory/                      DSH 插件（fork 自 dsh-hippocampus, MIT）
ref-hippocampus/                 上游参考，别改
*.md / *.json                    早期语料分析的产物，留着当证据
```

## 两个库，别搞混

- `~/.opencode-mem/` —— **我的**记忆（跨项目，带 ws 标签）
- `~/.dsh/dsh-memory/` —— **DSH 的**记忆（按工作区隔离）

DSH 那边「换文件夹等于换一个人」是有意的（多身份场景）；
我这边不切，因为只有一个用户，换文件夹不该失忆。
