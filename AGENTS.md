# 记忆项目 · AGENTS.md

给 agent 做长期记忆。DSH 用的插件在 `dsh-memory/`；**我自己用的在 `.opencode/plugins/self-memory/`**。

## 记忆是自动的

插件挂了三个钩子，不靠我"记得去记"：

| 钩子 | 干什么 |
|---|---|
| `prompt` | 用户消息一进来就落盘 |
| `context` | 补记助手消息；注入「醒来块」和「这事以前碰过」 |
| `compaction` | 上下文被压掉时记一笔 |

数据在 `~/.opencode-mem/`（全局一个库，`ws` 标签只做过滤，不做隔离）。

**钩子只记"说过什么"，不记"得出了什么"。** 判断、结论、待办仍然要显式写。

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
```

会话里也有工具：`recall` / `trace` / `remember` / `map` / `alias`。

**分工**：`recall` 管意思，`trace` 管归属。「你是不是答应过我」只认 `trace`。

**地图是视图，不是存储。** `map` 每次从 facet 现算，删了不影响任何数据；
结构不可写，只有别名可写——别名错了是局部影响，结构错了是全局失明。

## 硬规则

1. `~/.opencode-mem/stream.jsonl` **只追加，不手改**。
2. **摘要只当索引**。写结论时，要能说清它是从哪段原文推出来的。
3. 不确定的写「待验证」，不要写成结论——错的东西一旦进库，会被反复强化。

## 目录

```
.opencode/plugins/self-memory/   我自己用的记忆插件（钩子 + 工具）
tools/mem-core.mjs               存储与检索（CLI 和插件共用）
tools/mem.mjs                    CLI
dsh-memory/                      DSH 插件（fork 自 dsh-hippocampus, MIT）
ref-hippocampus/                 上游参考，别改
*.md / *.json                    早期语料分析的产物，留着当证据
```

## 两个库，别搞混

- `~/.opencode-mem/` —— **我的**记忆（跨项目，带 ws 标签）
- `~/.dsh/dsh-memory/` —— **DSH 的**记忆（按工作区隔离）

DSH 那边「换文件夹等于换一个人」是有意的（多身份场景）；
我这边不切，因为只有一个用户，换文件夹不该失忆。
