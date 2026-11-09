// 通用安装/识别层。现有三套实现作为后端保留，安装器只负责选对 adapter。
//
// 这一层不是运行时插件，而是“安装时识别 + 运行时能力校验”的收敛入口：
//   node agent-memory/install.mjs --dry-run
//   node agent-memory/install.mjs --harness dsh --workspace "D:\deepseek harness"
//   node agent-memory/install.mjs --harness opencode
//   node agent-memory/install.mjs --harness workbuddy
//
// 为什么不在运行时硬猜：
//   DSH 是常驻事件流，OpenCode 是请求钩子，WorkBuddy 是每次 hook 起进程。
//   三者的捕获语义不同，adapter 必须显式选择；自动探测只做兜底。
import { detectHarnesses, chooseHarness } from './detect.mjs'

export { detectHarnesses, chooseHarness }
export { parseArgs, planInstall, execute } from './install.mjs'
