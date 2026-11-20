# Codex 记忆插件

插件使用 `UserPromptSubmit` 和 `Stop` 保存用户提示和 Codex 提供的最后一条助手回复。原话、换行、会话和轮次写入独立的追加式账本。同一轮的相同事件重试只写一次。默认库为 `~/.agent-memory/codex/stream.jsonl`，可用 `AGENT_MEMORY_HOME` 切换共享根，或用 `CODEX_MEMORY_HOME` 指定 Codex 库。

```powershell
node codex-memory/install.mjs
```

安装器打包本地 marketplace，再用 `codex plugin` 注册并安装。安装后打开新会话，在 Codex 的 Hooks 页面审阅 `codex-memory` 的两个钩子。插件从信任之后的新会话事件开始记录。当前覆盖钩子提供的文字，工具、子代理和中断回复的采集待后续实现。

按需使用 `codex-memory` 技能，或从仓库直接调用共享检索和体检。

```powershell
node agent-memory/recall.mjs recall "线索" --source codex
node agent-memory/recall.mjs show codex:1
node agent-memory/coverage.mjs --source codex
```

`node codex-memory/install.mjs --package-only` 生成本地包。`node --test codex-memory/test.mjs` 使用临时账本验证打包后的脚本。
