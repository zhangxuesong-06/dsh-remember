// adapter 注册表：新增一个 harness 只需要加一个文件并在这里登记。
import * as dsh from './dsh.mjs'
import * as opencode from './opencode.mjs'
import * as workbuddy from './workbuddy.mjs'
import * as zcode from './zcode.mjs'

export const ADAPTERS = {
  [dsh.meta.id]: dsh,
  [opencode.meta.id]: opencode,
  [workbuddy.meta.id]: workbuddy,
  [zcode.meta.id]: zcode,
}

export const ADAPTER_LIST = Object.values(ADAPTERS).map((a) => a.meta)
