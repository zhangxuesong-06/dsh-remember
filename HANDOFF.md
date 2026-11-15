# 交接文档

日期：2026-11-15  
工作区：`C:\Users\HUAWEI\Desktop\work\记忆`  
用途：给下一个 harness / 下一个接手的人，快速了解当前状态、OpenCode 启动问题、以及记忆系统怎么继续开发。

---

## 1. 当前状态

### 1.1 记忆系统

三套实现都还在，各自保留自己的事件模型和证据链：

| harness | 代码 | 运行时数据 |
|---|---|---|
| OpenCode | `plugin/self-memory/` + `tools/` | `~/.agent-memory/opencode/` |
| DSH | `dsh-memory/` | `~/.agent-memory/dsh/` |
| WorkBuddy | `workbuddy-memory/` | `~/.agent-memory/workbuddy/` |

共享仓库迁移已在 **2026-11-15 10:56** 完成：

```text
~/.agent-memory/
  manifest.json
  opencode/stream.jsonl
  dsh/<工作区>/stream.jsonl
  workbuddy/stream.jsonl
```

当前计数（`node agent-memory/recall.mjs sources`，截至 2026-11-15 11:03，会随对话增长）：

```text
opencode   约 2,750 条对话
dsh        1,077 条（对话 191 · 工具 886）
workbuddy  1,163 条（对话 117 · 工具 1,046）
```

旧库未删除，仍作为只读备份：

```text
~/.opencode-mem/
~/.dsh/dsh-memory/
~/.workbuddy/mem/
```

迁移日志在 `~/.agent-memory/activation.log`。

### 1.2 代码状态

最近一次提交是用户自己做的；助手没有执行 `git add` / `commit` / `push`。

当前未提交改动：

```text
M README.md
M agent-memory/RECALL.md
M agent-memory/migrate.mjs          # 新增 --sync 增量同步
M agent-memory/migrate.test.mjs     # 新增 sync 测试
M agent-memory/repo.mjs             # 显式旧库 env 优先于共享自动检测
?? agent-memory/activate.cmd        # 一键迁移/同步（推荐入口）
?? agent-memory/activate.ps1        # PowerShell 版，双击容易闪退
?? HANDOFF.md                        # 本文件
```

另外 `?? .zcode/`、`?? .zcodeignore`、`?? zcode-memory/` 是新 harness（ZCode）产生的，
不属于本次记忆插件改动，未处理。

### 1.3 测试基线

```text
OpenCode        29 / 29
跨库查询        13 / 13
迁移/同步        6 / 6
agent-memory    17 / 17
WorkBuddy 源码  16 / 16
WorkBuddy 已安装 16 / 16
DSH selftest   100 / 100
DSH smoke       61 / 61
```

命令：

```powershell
node --test tools/tests/memory.test.mjs
node --test agent-memory/recall.test.mjs
node --test agent-memory/migrate.test.mjs
node agent-memory/test.mjs
node workbuddy-memory/test.mjs
node dsh-memory/selftest.mjs
node dsh-memory/smoke.mjs
```

---

## 2. OpenCode 启动慢 / 有时无法完全启动

### 2.1 结论

**主因不是 Git，也不是记忆库大小。**

启动链路上有两个外网请求会阻塞 provider/model 初始化：

1. **OpenCode 账号配置**：数据库里有一条 active 的 OpenCode OAuth 凭据，启动时请求  
   `https://opencode.ai/console/api/v2/config`。当前网络对这个带 token 的请求会
   `ECONNRESET`，日志里等 **27 秒**才失败，随后 `/api/provider`、`/api/model`
   返回 503。
2. **models.dev 目录**：直连 5.8–12.2 秒，内置超时 10 秒；超时就重试，日志每几分钟
   出现一次 `Failed to fetch models.dev`。

迁移完成后，项目目录的初始化已经正常：

```text
location services booted durationMs = 54 / 493 / 179 / 238 / 380
```

之前是 19,000 ms 左右。现在剩下的 20–55 秒主要是上面两个网络请求。

### 2.2 证据

当前启动 run `59ec7ffb`（2026-11-15 10:59 本地时间）：

```text
10:59:18  cli starting
10:59:18  location services booted  54ms / 493ms / 179ms
10:59:45  Failed to fetch models.dev  (timeout 10s, span 27.6s)
10:59:47  failed to load OpenCode provider config
          HttpClientError: Transport error
          GET https://opencode.ai/console/api/v2/config
          TypeError: ECONNRESET
11:00:13  /api/model 503 (span 27.4s)
11:00:13  /api/provider 503 (span 27.2s)
```

账号凭据：

```text
credential 表：1 条
integration_id = opencode
type = oauth, methodID = device
expires = 2026-12-03
```

同一时间：

- 不带 token 请求 `https://opencode.ai/console/api/v2/config`：快速返回 401；
- 带该 OAuth token 的请求：`fetch failed` / `ECONNRESET`；
- `models.dev`：5.8 秒（偶尔 12 秒），而 OpenCode 超时是 10 秒。

### 2.3 修复（已设置并验证）

#### 第一步：关掉两个联网刷新

用户级环境变量（2026-11-15 已写入当前用户环境）：

```powershell
setx OPENCODE_DISABLE_MODELS_FETCH 1
setx OPENCODE_DISABLE_FREE_MODELS 1
```

可选：

```powershell
setx OPENCODE_FAST_BOOT 1
```

隔离实例验证结果：

```text
带两个开关启动第二实例
/api/provider 200 就绪时间 = 2,440 ms
日志里没有 models.dev 错误，也没有 opencode.ai 账号配置错误
```

改完必须**完全退出** OpenCode，包括 `opencode-cli.exe`，再重新打开。  
当前正在运行的进程仍然是旧环境，重启后才生效。  
从开始菜单/桌面图标启动的，最好重启一次 Explorer 或重新登录，让新进程继承环境变量。

撤销：

```powershell
reg delete "HKCU\Environment" /v OPENCODE_DISABLE_MODELS_FETCH /f
reg delete "HKCU\Environment" /v OPENCODE_DISABLE_FREE_MODELS /f
reg delete "HKCU\Environment" /v OPENCODE_FAST_BOOT /f
```

说明：

- `OPENCODE_DISABLE_MODELS_FETCH=1` 会使用 `opencode.db` 里已有的 models.dev 缓存
  （`models-dev:v2:catalog`，约 12 MB），不会没模型；
- `OPENCODE_DISABLE_FREE_MODELS=1` 已验证能阻止启动时的
  `opencode.ai/console/api/v2/config` 请求；
- `OPENCODE_FAST_BOOT=1` 只跳过首屏初始加载，不解决网络等待，本次没有启用。

#### 备用：如果某些版本仍然请求账号配置，退出 OpenCode 登录

**退出 OpenCode 账号不会断 magpie 的 OpenCode Go。** 两者用的是不同的凭据：

```text
opencode.db credential   integration_id=opencode
                         access 以 st_ 开头，refresh 以 rt_ 开头（OAuth 会话）

magpie providers.json    opencode-go.key 以 oc_ 开头，51 位（API key）
                         和上面的 st_ / rt_ 不相等
```

magpie 实测调用 `opencode-go/deepseek-v4.1-flash` 返回 200；退出登录只移除本地
OAuth 会话，不会撤销 `oc_` API key。只要不去 `opencode.ai/auth` 撤销这个 key，
magpie 仍然可用。

可以在退出后自测：

```powershell
node -e "fetch('http://127.0.0.1:3425/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer magpie'},body:JSON.stringify({model:'opencode-go/deepseek-v4.1-flash',messages:[{role:'user',content:'ping'}],max_tokens:1})}).then(r=>console.log(r.status))"
```

期望 `200`。注意不要顺手点 “撤销所有会话/API keys”，那才会影响 magpie。

如果仍需要 OpenCode 内置 provider，优先修网络：

- 让 `opencode.ai` 和 `models.dev` 走一个稳定代理；
- 或重新登录，刷新可能已失效的 access token；
- 但即使网络正常，账号配置请求仍会增加启动时间，本地 magpie 场景下退出登录
  更确定。

#### 第三步：验证

重新启动后看最新日志：

```powershell
$f = "$env:USERPROFILE\.local\share\opencode\log\opencode.log"
Select-String -Path $f -Pattern 'Failed to fetch models.dev|failed to load OpenCode provider config' |
  Select-Object -Last 5
```

期望：没有新的命中；`location services booted` 都在 1 秒内。

当前服务健康检查（密码在 `~/.config/opencode/service.json`）：

```powershell
$pw = (Get-Content "$env:USERPROFILE\.config\opencode\service.json" -Raw | ConvertFrom-Json).password
curl.exe -s -o NUL -w "%{http_code} %{time_total}s`n" -u "opencode:$pw" http://127.0.0.1:28894/api/provider
```

期望：`200`，时间在几十毫秒内。启动阶段短暂 503 是正常的；如果 503 持续超过
一分钟，就是账号配置请求还在阻塞。

### 2.4 “有时无法完全启动”的恢复步骤

1. 看进程：正常应该只有一个 `opencode-cli.exe`。如果存在多个，全部结束再重开。
2. 结束：

```powershell
Get-Process OpenCode -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process opencode-cli -ErrorAction SilentlyContinue | Stop-Process -Force
```

3. 重新打开 OpenCode。
4. 如果仍然空白/卡住，看日志最后 50 行，重点找：
   - `failed to load OpenCode provider config`
   - `/api/provider ... 503`
   - `[self-memory] 载入失败`
   - `Runtime module missing / not listed`
5. 不要删除 `opencode.db`。需要排查时可以复制一份到临时目录再打开。

### 2.5 不是主因、但可以留意的项

- `opencode.db` 81 MB，WAL 15 MB，`session_message` 8,969 条。不是这次 27 秒的
  原因；如果以后启动明显变慢，可以在关闭 OpenCode 后做一次
  `PRAGMA wal_checkpoint(TRUNCATE)`，但不要在没有备份时 `VACUUM`。
- Git：干净时 `git status` 约 79 ms；未提交/未跟踪文件多时才会出现逐文件 diff
  的噪音。
- 插件加载：日志里 `loading plugin` 单次 1–5 ms；当前 run 有 10 次，主要来自
  多工作区/配置更新，不是 27 秒的来源。
- 当前工作区有未提交改动，OpenCode 的 VCS 面板会做额外 diff；接手开发时及时
  提交或 stash，能减少后台 git 进程。

---

## 3. 记忆系统怎么用

### 3.1 单库查询（OpenCode 自己的）

```powershell
node tools/mem.mjs recall "分块多大"
node tools/mem.mjs trace "扫码走局域网"
node tools/mem.mjs health
node tools/mem.mjs verify
node tools/mem.mjs show 123
```

### 3.2 跨库查询

```powershell
node agent-memory/recall.mjs sources
node agent-memory/recall.mjs recall "kgnav 孤岛" -n 8
node agent-memory/recall.mjs recall "题库" --source workbuddy --since 30d
node agent-memory/recall.mjs trace "扫码走局域网"
node agent-memory/recall.mjs show dsh:<行号>
```

只读，不合并、不写入、不自动注入。默认只查对话/笔记/决策/段落/产物；工具行加
`--with-tools`。

### 3.3 迁移与同步

```powershell
node agent-memory/migrate.mjs            # dry-run
node agent-memory/migrate.mjs --apply    # 首次迁移（需关闭三个 harness）
node agent-memory/migrate.mjs --sync     # 已迁移后接上旧库新增尾部
```

一键入口（会结束 OpenCode 和 `opencode-cli`）：

```text
agent-memory\activate.cmd
```

注意：`.ps1` 双击容易因为执行策略闪退，优先用 `.cmd`。

回退：

- 迁移后还没有新记录：删除 `~/.agent-memory`，三个写入端回到旧路径；
- 一旦共享库开始写入：先把 `~/.agent-memory/<harness>` 的流复制回旧路径，再删，
  否则会丢新记录。

### 3.4 写入端自动切换

- OpenCode：`~/.agent-memory/opencode` 存在就用它，否则 `~/.opencode-mem`；
- DSH：`~/.agent-memory/dsh` 存在就用它，否则 `~/.dsh/dsh-memory`；
- WorkBuddy：`~/.agent-memory/workbuddy` 存在就用它，否则 `~/.workbuddy/mem`；
- 显式 `OPENCODE_MEM_HOME` / `DSH_MEMORY_HOME` / `WORKBUDDY_MEM_HOME` 始终优先。

### 3.5 已知边界

- 跨库不做别名扩展、不做语义检索、不自动注入；
- DSH 的工作区隔离保留，只在结果里标目录名；
- WorkBuddy 的 `index.db` 没有被迁移，会在共享库里按需重建；
- 旧库的重复记录只在新视图里去重，原始账本不改。

---

## 4. 继续开发时看哪里

```text
tools/mem-core.mjs           OpenCode 存储、检索、缓存
tools/mem-capture.mjs        消息/工具/产物捕获
tools/mem-journal.mjs        append-only 账本、检查点、锁
tools/mem-plugin.mjs         钩子、注入、维护触发
tools/eval-recall.mjs        真实提问 → 当时回答的召回评测
agent-memory/repo.mjs        共享仓库布局解析
agent-memory/recall.mjs      跨库只读查询
agent-memory/migrate.mjs     迁移/同步
dsh-memory/lib/config.mjs    DSH 路径与默认根
workbuddy-memory/bin/mem.mjs WorkBuddy 入口与索引回退
docs/memory-reliability.md   可靠性、边界、维护
agent-memory/RECALL.md       跨库查询与迁移说明
```

### 下一步候选

1. OpenCode 启动：落地 `OPENCODE_DISABLE_MODELS_FETCH` / `OPENCODE_DISABLE_FREE_MODELS`
   或退出账号，确认 27 秒消失。
2. DSH / WorkBuddy 各自建「提问 → 当时回答」评测基线，再决定是否把时间衰减改成
   “新鲜加分”（OpenCode 已改，有数据支撑）。
3. 长回答分段检索：目标 hit@1 +5 个点、top-8 字符 -30%。
4. `mem digest --since 7d`：按时间窗汇总段落、决策、待办、产物。
5. 存储生命周期：blobs 目前约 65 MB / 几天，先观察增长率再定保留策略。

---

## 5. 安全与边界

- 记忆库是本地文件，不上传；跨库查询只读。
- 不要把 `service.json` 的密码、OAuth token、邮箱写进文档或提交。
- 助手没有执行 Git 提交/推送；当前未提交改动由接手的人决定怎么处理。
- 迁移只复制、不移动；旧库保留，回退前先确认共享库是否已有新写入。
