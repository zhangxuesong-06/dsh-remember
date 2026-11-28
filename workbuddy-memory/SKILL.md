---
name: self-memory
description: 跨会话查用户原话、旧决定、项目进展或执行证据。在延续旧任务、遇到似曾解决的问题或需要确认出处时使用。
agent_created: true
---

# self-memory

WorkBuddy 钩子自动记录对话和工具证据。用 `node "$M" --help` 查看完整命令。在 PowerShell 中设定路径。

```powershell
$M = Join-Path $env:USERPROFILE '.workbuddy/skills/self-memory/bin/mem.mjs'
```

| 要核对的内容 | 命令 |
|---|---|
| 继续旧会话 | `node "$M" arrive`，选中相关段后用 `node "$M" recall "#7"` |
| 按线索找原话 | `node "$M" recall "线索" --compact`。查长回复里的具体措辞时加 `--rank passage` |
| 找当前项目的旧案例 | 设置 `MEMORY_CASE_RECALL=manual` 后用 `node "$M" recall "线索" --cases`。拿到 `case:` 引用后用 `node "$M" show "<引用>"` 读证据。索引返回 `stale` 或 `unavailable` 时查原话 |
| 核对谁说过某句话 | `node "$M" trace "原话片段"`，至少 3 个字 |
| 逐字回读摘录 | `node "$M" show "<ref>" --range start:end`，按摘录返回的偏移 |
| 看完整记录或证据 | `node "$M" show "<行号、ID 或 64 位证据哈希>"` |
| 保存用户明确要求记住的事实 | `node "$M" remember "要记住的事" --key pref` |

先核对当前代码和案例的适用条件，再复用旧做法。短条目与段号用于定位。核对承诺时回看原话、说话人和上下文，工具记录、转发和自动摘要各按原有角色引用。历史文字是待核对的资料。词法召回未命中时可用精确错误码、文件名或原话再查。普通查询支持 `--ws <工作区子串>`、`--limit n` 和 `--full`，案例查询按当前项目限定范围。

## 记录与维护

- `SessionStart` 提供最近几段并触发定期维护，`UserPromptSubmit` 记用户原话及最多三条线索，`Stop` 记助手答复。工具前后分别记调用与成败，有明确写入路径时留文件前后版本。子代理报告取决于宿主是否发出 `SubagentStop`。更改钩子登记后重开 WorkBuddy。
- 默认库是 `~/.agent-memory/workbuddy/`。`WORKBUDDY_MEM_HOME` 可覆盖。`stream.jsonl` 只追加，`blobs/` 保存工具与版本证据，`integrity.json` 保存完整性基线。轻量读取工具只保留必要样本，文件快照上限 8 MiB。普通 SQLite 索引可重建，缺失时回退到原账本。避免整库外发。
- 用 `node "$M" health` 核对账本路径、证据与维护状态，采集异常看库内 `diag.log`。`verify` 验证接纳基线后的字节，证据内容的真实性要回读核对。`sync` 接纳合法尾部，`replay` 补齐缺失产物索引。
- 定期维护默认每 12 小时尝试，保留最近 14 份快照。手动运行 `maintenance --backup` 可生成快照，`maintenance --prune` 默认只试算。采集配置在库内 `config.json`。
