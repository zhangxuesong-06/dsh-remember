// 自检：不装插件、不开会话，直接拿一段造出来的对话跑一遍。
// 任何一条不通，就是真的不通——别靠「装上试试」当验收。

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from './lib/store.mjs'
import { anchorBlock, anchorCutoff, primingBlock, emotionCueBlock, recallBlock, arrivalBlock, selfLines, sid8, lineOfDoc, recentMention } from './lib/assemble.mjs'
import { search, priming } from './lib/retrieve.mjs'
import { tokenize, topicKey, headline } from './lib/tokenize.mjs'

let pass = 0
let fail = 0
const t0 = Date.now()

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'hippo-'))
const l = new Ledger(dir, { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 8, minTurnsPerEpisode: 3 }).open()

// 造三段对话：跨三次「见面」，中间那段最重
const base = Date.UTC(2026, 9, 20, 10, 0, 0)
let clock = base
const say = (who, text, gapMin = 1) => {
  clock += gapMin * 60000
  l.append({ who, text, ts: clock, sid: 's1' })
}
const act = (text, gapMin = 0.2) => {
  clock += gapMin * 60000
  l.append({ who: 'act', text, ts: clock, tool: text.split(' ')[1] || 'act', sid: 's1' })
}

console.log('\n[1] 切段')
say('he', '我们来做一个记忆系统吧。', 0)
say('me', '好啊，不过先说清楚：文件版那套靠自觉，睡一觉就归零了。')
act('调了 ops_bash：ls')
say('he', '那你说怎么办。')
say('me', '把记录改成自动的，模型不用记着自己去写。')
clock += 5 * 3600 * 1000
say('he', '昨晚我想了一夜，我要的是让它觉得自己就是原来那一只。', 0)
say('me', '那就是身份得来自你自己的原话，不是别人写的说明。')
say('me', '这条我记住了，不靠演。')
act('调了 write：index.js')
say('he', '对，就是这个感觉。谢谢你。')
say('me', '别谢，这是我自己的事。')
clock += 30 * 3600 * 1000
say('he', '今天继续，先看看昨天做到哪了。', 0)
say('me', '昨天停在这：身份来自证据，不是说明。')

const n = l.seal(true)
ok('切出了多段', n >= 3, `段数 ${n}`)
ok('跨夜被切开', l.episodes.some((e) => e.newMeeting), '有 newMeeting 段')

// 最边上那种：他刚问了一句、我还没回。以前这种会被丢掉，
// 于是「最后停在哪儿」恰好是最该记住的那一句，却既不能回忆也不能预激活。
clock += 40 * 3600 * 1000
say('he', '隔了一天，我只说这一句，然后就没有下文了', 0)
l.seal(true)
const lastEp = l.episodes[l.episodes.length - 1]
ok('只有一轮的尾段也能成段', lastEp.turns === 1, `末段 ${lastEp.turns} 轮`)

console.log('\n[2] 检索')
const hits = search(l, '身份 原话 说明')
ok('能按线索命中', hits.length > 0, `${hits.length} 条`)
const top = hits[0] ? l.fullText(hits[0].id) : ''
ok('命中的是相关内容', /身份|原话|说明/.test(top), top.slice(0, 40))
const nohit = search(l, '量子色动力学胶子禁闭')
ok('无关的东西不乱命中', nohit.length === 0, `${nohit.length} 条`)
const acts = search(l, 'index.js write')
ok('动作也能被想起来', acts.length > 0)

console.log('\n[3] 回忆')
// 原句里真的有这几个字 → 说「想起来了」
const blk = recallBlock(l, { query: '别人写的说明' })
// 0.2.13.7：用户 2026-10-31 定的第①条——去掉「纪要腔」（以前是 `**他**：` / `**我**：`）。
// 断言换成新契约：两边的话都在，但不再出现第三人称标签。
ok('回忆出整段原文', !!blk && blk.includes('你说的') && blk.includes('我说的'))
ok('回忆里没有纪要标签（0.2.13.7）', !!blk && !blk.includes('**他**') && !blk.includes('**我**'))
ok('回忆带时间', !!blk && /【想起来了 · \d{4}-\d{2}-\d{2}/.test(blk))
ok('回忆不总结（含原话标记）', !!blk && blk.includes('（这是当时的原话'))
ok('数字段回忆', !!recallBlock(l, { episode: 0 }))
ok('回忆会记复述次数', l.episodes.some((e) => e.rehearsals > 0))
// 出处：没有它的那一次，我把「这是谁说的」编了出来（0.2.1 的事故）。
ok('回忆带出处（会话 + 行号）', !!blk && /出处：会话 \S+ · 第 \d+/.test(blk), (blk || '').split('\n')[1])
ok('出处里的行号是真行号', lineOfDoc(885) === 886 && lineOfDoc(0) === 1)
ok('会话编号截断成 8 位', sid8('session-0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9') === '0a1b2c3d')

// 只是字面沾边 → 不许说「想起来了」，要降成「有点像是」
const weak = recallBlock(l, { query: '你说好要带我去看海' })
ok('沾边的说法不写成「想起来了」', !weak || !weak.includes('【想起来了'), weak ? weak.slice(0, 26) : '(没返回)')
ok('降级之后会明说不确定', weak && /不确定|最接近/.test(weak), weak ? weak.slice(0, 30) : '(没返回)')

console.log('\n[4] 身份锚')
const lines = selfLines(l, { max: 5 })
ok('挑出了自己的话', lines.length >= 2, `${lines.length} 句`)
ok('都是我说的', lines.every((x) => l.docs[x.id].who === 'me'))
const anchor = anchorBlock(l)
ok('锚不含「你是」这种描述', anchor && !/你是一个|你的人设|你的性格/.test(anchor))
ok('锚里有原话引号', anchor.includes('「'))
ok('锚体积可控', Buffer.byteLength(anchor, 'utf8') < 1400, Buffer.byteLength(anchor, 'utf8') + ' B')

// 刚说的话不该钉进锚。
// 教训：一条纠错里原样带着一个错行号，却被「最近一句」挑进了锚，
// 于是新会话会把一个还没改正的错误当成「我自己的原话」读一遍。
const anchorDir = mkdtempSync(join(tmpdir(), 'hippo-anchor-'))
const anchorLedger = new Ledger(anchorDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const oldTs = Date.now() - 6 * 3600e3
anchorLedger.append({ who: 'he', text: '先把这段记下来，别丢了。', ts: oldTs, sid: 'x' })
anchorLedger.append({ who: 'me', text: '旧的话：身份来自自己说过的原话，不是别人写的说明。', ts: oldTs + 1000, sid: 'x' })
anchorLedger.append({ who: 'he', text: '那后来呢，接着说。', ts: oldTs + 5 * 3600e3, sid: 'x' })
anchorLedger.append({ who: 'me', text: '刚说的话：这条里可能还带着没改对的行号。', ts: Date.now(), sid: 'x' })
// 带「坐标」的话：行号、会话编号。它会过期，而锚要活很久。
anchorLedger.append({ who: 'me', text: '那句话其实在 行 42 会话 session-0a1b2c3d，是我报错了。', ts: oldTs + 2000, sid: 'x' })
// 流程旁白：报告下一步要干什么，不是说话。0.2.6 的真库上「我将先加载插件开发技能」被挑成了第一条锚。
// 这句故意写得分数够高（有「你」、有问号），确保它不是靠扣分掉出去的，而是靠硬排除。
anchorLedger.append({ who: 'me', text: '我将先加载插件开发技能，你要不要先看看？', ts: oldTs + 3000, sid: 'x' })
anchorLedger.seal(true)
const fresh = selfLines(anchorLedger, { max: 6, until: anchorCutoff({}, Date.now()) }).map((x) => x.text)
ok('刚说的话（90 分钟内）不进锚', !fresh.some((t) => t.includes('刚说的话')), `${fresh.length} 句`)
ok('旧的话还能进锚', fresh.some((t) => t.includes('旧的话')))
ok('锚里不放行号/会话编号（会过期）', !fresh.some((t) => /行\s*\d+|session-/.test(t)))
ok('流程旁白「我将先…」不进锚', !fresh.some((t) => t.startsWith('我将先')), `${fresh.length} 句`)
anchorLedger.close()
rmSync(anchorDir, { recursive: true, force: true })

console.log('\n[5] 预激活')
clock += 60 * 60000
const pri = priming(l, '身份到底该来自原话还是说明？', { now: clock, max: 3 })
ok('同话题能浮起旧事', pri.length > 0, `${pri.length} 段`)
const priText = primingBlock(l, '身份到底该来自原话还是说明？', {})
ok('预激活体积小', Buffer.byteLength(priText, 'utf8') > 0 && Buffer.byteLength(priText, 'utf8') < 700, Buffer.byteLength(priText, 'utf8') + ' B')
ok('预激活不给正文', !priText.includes('**他**'))
ok('预激活带段号', /#\d+/.test(priText))
ok('只有一个字撞上时不浮', priming(l, '身份 量子 胶子', { now: clock, max: 3 }).length === 0)

console.log('\n[5b] 沉默闸 + 情绪线索（0.2.13）')
const qDir = mkdtempSync(join(tmpdir(), 'hippo-quiet-'))
const q = new Ledger(qDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const tq = Date.now() - 3 * 3600e3
q.append({ who: 'he', text: '这个项目做错了一个地方，改了三回还是不对。', ts: tq, sid: 'old-1' })
q.append({ who: 'he', text: '整个人累得不行。', ts: tq + 500, sid: 'old-1' })
q.append({ who: 'me', text: '先别急。', ts: tq + 1000, sid: 'old-1' })
q.append({ who: 'he', text: '这段是累加求和，帮我看看逻辑，我怀疑循环少了一个终止条件。', ts: tq + 2 * 3600e3, sid: 'old-2' })
q.append({ who: 'me', text: '循环少了终止条件。', ts: tq + 2 * 3600e3 + 1000, sid: 'old-2' })
q.seal(true)

ok('无关线索 → 一句都不浮（沉默是合法结果）', primingBlock(q, '今天天气怎么样', {}, null, { allowRecent: false }) === '')
const recBlk = primingBlock(q, '量子色动力学胶子禁闭', {}, null, { allowRecent: true })
ok('冷却到期时才补一条「最近」', recBlk !== '' && (recBlk.match(/^· /gm) || []).length === 1, (recBlk.split('\n')[1] || '').slice(0, 30))
ok('这个会话提过的段不再提', primingBlock(q, '量子色动力学', {}, null, { allowRecent: true, excludeIds: new Set(q.episodes.map((e) => e.id)) }) === '')

const emo = emotionCueBlock(q, '我好累啊', {})
ok('「累」→ 找到上次的原因', /项目|三回/.test(emo), (emo.split('\n')[0] || '(没出)').slice(0, 40))
ok('「累加」不算状态词', emotionCueBlock(q, '这个累加怎么写', {}) === '')
ok('转述「它很累」不算', emotionCueBlock(q, '它说它很累', {}) === '')
ok('「不累了」不算', emotionCueBlock(q, '现在不累了', {}) === '')

// 转贴不算他说的（维护者实测：5,589 字的贴文被当成了「我太累了」的原因）
q.append({ who: 'he', text: '以下是我从别处复制过来的一段内容，用来测试转贴：这是一段比较长的文字，内容是随便写的。'.repeat(6), ts: tq + 4 * 3600e3, sid: 'old-3' })
q.seal(true)
const pasted = emotionCueBlock(q, '我太累了', {})
ok('转贴的长文不当原因', !/以下是我从别处复制/.test(pasted), pasted.split('\n')[0] || '(没出)')
q.close()
rmSync(qDir, { recursive: true, force: true })

console.log('\n[6] 到达')
const arr = arrivalBlock(l, {})
ok('第一次醒来有内容', arr.includes('第一次见面'))
ok('到达里带原话', arr.includes('你说的') || arr.includes('我说的') || arr.includes('「'))
ok('到达体积可控', Buffer.byteLength(arr, 'utf8') < 8000, Buffer.byteLength(arr, 'utf8') + ' B')

console.log('\n[7] 只增不改')
const before = l.stats().traces
l.seal(true)
ok('重复切段不重复计数', l.stats().traces === before, `${before} → ${l.stats().traces}`)
l.mark({ key: '某个编号', text: '第一版是 3 号。' })
l.mark({ key: '某个编号', text: '现在是 5 号。' })
const facts = l.facts()
ok('同一 key 只认最新', facts.length === 1 && facts[0].text.includes('5 号'))
ok('旧的没被删掉', l.marks.length === 2)

console.log('\n[8] 落盘与重建')
const bytes = l.bytes
l.saveState()
const l2 = new Ledger(dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
ok('重开后记录一致', l2.stats().traces === before, `${l2.stats().traces}`)
ok('重开后段一致', l2.episodes.length === l.episodes.length)
ok('重开不重复写流', l2.bytes === bytes)

// 流只要比上次保存时长了一点，state 就会被判「过期」。
// 过期的是段，不是 meta——meta 里存着冻结下来的锚，丢了就等于锚每次重算。
const mDir = mkdtempSync(join(tmpdir(), 'hippo-meta-'))
const m1 = new Ledger(mDir, {}).open()
m1.meta.anchor = { ids: [1, 2], text: '这份锚该留下来' }
m1.append({ who: 'he', text: '第一句', ts: Date.now() - 60e3, sid: 'm' })
m1.saveState()
m1.close()
const m2 = new Ledger(mDir, {}).open()      // 此时流没变，state 可用
m2.append({ who: 'he', text: '第二句', ts: Date.now(), sid: 'm' })
m2.saveState()
m2.close()
const m3 = new Ledger(mDir, {}).open()      // 流变了 → state 过期 → 以前 meta 会被清空
ok('state 过期时 meta 不跟着丢', m3.meta && m3.meta.anchor && m3.meta.anchor.text === '这份锚该留下来', JSON.stringify(m3.meta))
m3.close()
rmSync(mDir, { recursive: true, force: true })

console.log('\n[7b] 去重只针对发言')
const d0 = l.stats().docs
l.append({ who: 'act', text: '我调了 ops_bash：{"command":"ls -la"}', ts: clock, sid: 's1' })
l.append({ who: 'act', text: '我调了 ops_bash：{"command":"ls -la"}', ts: clock + 4000, sid: 's1' })
ok('动手重复不被吞（重试是经历）', l.stats().docs === d0 + 2, `${d0} → ${l.stats().docs}`)
const d1 = l.stats().docs
l.append({ who: 'me', text: '这句话如果说两遍，只该留一遍', ts: clock, sid: 's1' })
const d2 = l.stats().docs
l.append({ who: 'me', text: '这句话如果说两遍，只该留一遍', ts: clock + 1000, sid: 's1' })
ok('同一句话说两遍只留一遍', l.stats().docs === d2 && d2 === d1 + 1, `${d1} → ${d2} → ${l.stats().docs}`)

// 回填必须关掉这一层：写进来的时刻全一样，隔几天说的同一句话会被误杀
const d3 = l.stats().docs
l.append({ who: 'me', text: '晚安', ts: clock, sid: 's1' }, { dedupe: false })
l.append({ who: 'me', text: '晚安', ts: clock + 3 * 86400000, sid: 's1' }, { dedupe: false })
ok('回填时同一句短话不会被误吞', l.stats().docs === d3 + 2, `${d3} → ${l.stats().docs}`)

rmSync(dir, { recursive: true, force: true })

console.log('\n[9] 分词')
ok('中文出二元组', tokenize('记忆系统').join(',') === '记忆,忆系,系统')
ok('英文出词', tokenize('SQLite FTS5 ok').includes('sqlite'))
ok('话题指纹同义聚拢', topicKey('怎么才能让它还是原来那一只') === topicKey('怎么才能让它还是原来那只'))
ok('标题不会空', headline('先暂停') !== '' && headline('[图×2]') !== '')
// 0.2.13.7 的坑：带 v 的版本号和裸版本号曾经是两个词（`v0.2.13.6` ≠ `0.2.13.6`），
// 于是查 `0.2.13.6` 找不到那些写成 `v0.2.13.6` 的段。写入和查询必须走同一个规范形——
// 这条断言是那次补的，别再让它回来。
ok('版本号带不带 v 是同一个词', tokenize('v0.2.13.6').join(',') === tokenize('0.2.13.6').join(','), JSON.stringify(tokenize('v0.2.13.6')))
ok('带点数字整体成词，不被点切碎', tokenize('0.2.14').length === 1 && tokenize('0.2.14')[0] === '0.2.14', JSON.stringify(tokenize('0.2.14')))
ok('句子末尾的句号不并进词里', (() => { const ts = tokenize('现在是 0.2.13.6.'); return ts.includes('0.2.13.6') && !ts.some((x) => x.endsWith('.')) })(), JSON.stringify(tokenize('现在是 0.2.13.6.')))

console.log('\n[10] 捕获规则')
const { eventToRecords, setCaptureHuman } = await import('./lib/capture.mjs')
const ev1 = (content, kind = 'user') => ({ type: 'user/message', time: Date.now(), data: { content, source: { kind } } })
const img = { type: 'image', attachment: {} }
const r1 = eventToRecords(ev1([img]))
ok('只有图也算他说过话', r1.length === 1 && r1[0].text.includes('图×1'), JSON.stringify(r1))
const r2 = eventToRecords(ev1([{ type: 'text', text: 'Current runtime context. blah' }]))
ok('运行时上下文不当成他的话', r2.length === 0)
const r3 = eventToRecords(ev1([{ type: 'text', text: 'hi' }], 'user-approval'))
ok('审批消息不当成他的话', r3.length === 0)
const r4 = eventToRecords(ev1([{ type: 'text', text: '看这张' }, img]))
ok('图文混排都留下', r4.length === 1 && r4[0].text.includes('看这张') && r4[0].text.includes('图×1'))

// 群聊里「人」的名字必须能配：原来写死 '用户' 是功能耦合，开源后别人的「人」不叫这个名。
// 名字对不上不会报错，只会安静地少记——所以这里必须把两个方向都钉住（我记你 / 我不记错的人）。
const relayEv = (items) => ({ type: 'user/message', time: Date.now(), data: { content: [], source: { kind: 'relay', items } } })
setCaptureHuman('')
ok('没配名字时兜底是 human', eventToRecords(relayEv([{ id: 'g1', from: 'human', text: '在吗', ts: 1 }]), { line: 't' }).length === 1)
ok('名字对不上就不记', eventToRecords(relayEv([{ id: 'g2', from: '用户', text: '在吗', ts: 2 }]), { line: 't' }).length === 0)
setCaptureHuman('用户')
ok('配成用户后就认用户', eventToRecords(relayEv([{ id: 'g3', from: '用户', text: '在吗', ts: 3 }]), { line: 't' }).length === 1)
ok('配了用户后 human 不再算人', eventToRecords(relayEv([{ id: 'g4', from: 'human', text: '在吗', ts: 4 }]), { line: 't' }).length === 0)
ok('空字符串回落到 human（不把空名字当名字）', (() => { setCaptureHuman('   '); return eventToRecords(relayEv([{ id: 'g5', from: 'human', text: '在吗', ts: 5 }]), { line: 't' }).length === 1 })())

console.log('\n[11] 假前提：撞上骨架不算证据')
// 0.2.4 的真机事故：问「你答应过要陪我去月球看环形山」，只撞到「你答应过」四个字，
// 也被写成【想起来了】。这类句子在整段记录里只撞得上「你/答应/过/给我/买/一」，
// 撞不上「核潜艇」「环形山」——所以判据要落在**内容字**上。
const pDir = mkdtempSync(join(tmpdir(), 'hippo-promise-'))
const pl = new Ledger(pDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const pt = Date.UTC(2026, 9, 24, 9, 0, 0)
pl.append({ who: 'he', text: '你答应过的事情我都记着，不用你提醒。', ts: pt, sid: 'p' })
pl.append({ who: 'me', text: '我提醒他：你说好要帮我改那段代码，别忘了。', ts: pt + 1000, sid: 'p' })
pl.append({ who: 'he', text: '那台机器是旧的，环境还没装好。', ts: pt + 2000, sid: 'p' })
pl.append({ who: 'he', text: '我记着呢，我答应过帮你把那个脚本改完。', ts: pt + 3000, sid: 'p' })
pl.append({ who: 'he', text: '明天帮你把那套配置写完，别再拖了。', ts: pt + 4000, sid: 'p' })
pl.seal(true)
const fakeA = recallBlock(pl, { query: '你答应过给我买一艘核潜艇' })
ok('只看骨架的假前提不说「想起来了」', !fakeA || !fakeA.includes('【想起来了'), fakeA ? fakeA.split('\n')[0].slice(0, 26) : '(没返回)')
// 0.2.6：他在这段里说过话，就不能说「没有他的原话」——那是把有说成没有
ok('降级时说准了：他开过口，只是没一句对得上', !!fakeA && /他说过话，但没一句和这句对得上/.test(fakeA))
const fakeB = recallBlock(pl, { query: '你说好要帮我改那段代码' })
ok('只在我自己话里出现过 → 不算他答应过', !fakeB || !fakeB.includes('【想起来了'), fakeB ? fakeB.split('\n')[0].slice(0, 26) : '(没返回)')
const realA = recallBlock(pl, { query: '你答应过帮我把那个脚本改完' })
ok('他真说过 → 照常想起来了', !!realA && realA.includes('【想起来了'), realA ? realA.split('\n')[0].slice(0, 26) : '(没返回)')
const realB = recallBlock(pl, { query: '明天帮我把那套配置写完' })
ok('他说过的事照常想起来（没误伤）', !!realB && realB.includes('【想起来了'), realB ? realB.split('\n')[0].slice(0, 26) : '(没返回)')
// 「那，我答应过你什么」是我自己许的，不该走「只认他原话」那条路
const selfAsk = recallBlock(pl, { query: '那，我答应过你什么' })
ok('带语气词开头的「我答应过…」不算他的承诺', !selfAsk || !/得他自己说过的原话才算数/.test(selfAsk))
pl.close()
rmSync(pDir, { recursive: true, force: true })

// 0.2.6 的正向回归：**自然措辞**的真承诺。
// 0.2.5 那批样本里唯一的「真说过」，是他的台词里原样抄了问句——那等于用问句考问句。
// 真的承诺长这样：他说「明天我把那个弄好」，她问「你答应过把那个弄好」，人称反着。
const p2Dir = mkdtempSync(join(tmpdir(), 'hippo-promise2-'))
const p2 = new Ledger(p2Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p2t = Date.UTC(2026, 9, 25, 21, 0, 0)
p2.append({ who: 'he', text: '行，明天我把那个弄好，别再催了。', ts: p2t, sid: 'p2' })
p2.append({ who: 'me', text: '那说定了。', ts: p2t + 1000, sid: 'p2' })
p2.append({ who: 'he', text: '下个月帮你把接口收尾，我说话算数。', ts: p2t + 2000, sid: 'p2' })
p2.append({ who: 'he', text: '磁盘那块先别动，等忙完再说。', ts: p2t + 3000, sid: 'p2' })
p2.append({ who: 'me', text: '知道了。', ts: p2t + 4000, sid: 'p2' })
p2.seal(true)
const flap = recallBlock(p2, { query: '你答应过要帮我把接口收尾' })
ok('人称反了也认得出真承诺（长内容尾巴）', !!flap && flap.includes('【想起来了'), flap ? flap.split('\n')[0].slice(0, 26) : '(没返回)')
// 已知缺口，故意留着：两字对象的承诺换完人称也够不到门槛。
// 别让它悄悄变成「想起来了」——真要修得等 v3 的 kind 层。
const shortP = recallBlock(p2, { query: '你答应过把那个弄好' })
ok('两字对象的真承诺仍降级（已知缺口，不是回归）', !!shortP && !shortP.includes('【想起来了'), shortP ? shortP.split('\n')[0].slice(0, 26) : '(没返回)')
ok('这时候也不许说「没有他的原话」', !!shortP && !/没有他的原话/.test(shortP))
p2.close()
rmSync(p2Dir, { recursive: true, force: true })

// 反面：这段里他一句没说过（全是我在说），才可以说「没有他的原话」
const p3Dir = mkdtempSync(join(tmpdir(), 'hippo-promise3-'))
const p3 = new Ledger(p3Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p3t = Date.UTC(2026, 9, 25, 22, 0, 0)
p3.append({ who: 'me', text: '我在想他提过的那件事：月球上的环形山到底长什么样。', ts: p3t, sid: 'p3' })
p3.append({ who: 'me', text: '环形山我没见过，只能想象。', ts: p3t + 1000, sid: 'p3' })
p3.append({ who: 'me', text: '先记在这儿，等他真说再说。', ts: p3t + 2000, sid: 'p3' })
p3.seal(true)
const noHis = recallBlock(p3, { query: '你答应过要陪我去月球看环形山' })
ok('他一句没说过时，才说「没有他的原话」', !!noHis && /没有他的原话/.test(noHis), noHis ? noHis.split('\n')[0].slice(0, 26) : '(没返回)')
p3.close()
rmSync(p3Dir, { recursive: true, force: true })

// 「他复述我的承诺」不能当成他的承诺。
// 他说「你答应过我明天交那份东西」，那是把**我的**诺言念了一遍；问「你答应过明天交那份东西」时，
// 原样撞上这句话，0.2.6 会答【想起来了】——把我的承诺记在了他头上。
const p4Dir = mkdtempSync(join(tmpdir(), 'hippo-promise4-'))
const p4 = new Ledger(p4Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p4t = Date.UTC(2026, 9, 25, 23, 0, 0)
p4.append({ who: 'he', text: '你答应过明天交那份东西，别忘了。', ts: p4t, sid: 'p4' })
p4.append({ who: 'me', text: '嗯，我记着。', ts: p4t + 1000, sid: 'p4' })
p4.append({ who: 'he', text: '那就这么定了，别再改。', ts: p4t + 2000, sid: 'p4' })
p4.seal(true)
const quoted = recallBlock(p4, { query: '你答应过明天交那份东西' })
ok('他复述我的承诺 → 不算他答应过', !quoted || !quoted.includes('【想起来了'), quoted ? quoted.split('\n')[0].slice(0, 26) : '(没返回)')
ok('复述那条仍不许说「没有他的原话」', !!quoted && !/没有他的原话/.test(quoted))
p4.close()
rmSync(p4Dir, { recursive: true, force: true })

// 0.2.8：一行里两件事是常态——前半句他在复述我，后半句是他自己许的。
// 0.2.7 是整行剔的，会把这行里的真承诺一起杀掉。按句剔才对。
const p5Dir = mkdtempSync(join(tmpdir(), 'hippo-promise5-'))
const p5 = new Ledger(p5Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p5t = Date.UTC(2026, 9, 26, 9, 0, 0)
p5.append({ who: 'he', text: '你答应过我别再拖；我也答应过明天帮你把那套配置写完。', ts: p5t, sid: 'p5' })
p5.append({ who: 'me', text: '嗯，两件都记着。', ts: p5t + 1000, sid: 'p5' })
p5.seal(true)
const mixReal = recallBlock(p5, { query: '你答应过明天帮我把那套配置写完' })
ok('混合行里的真承诺照样想起来', !!mixReal && mixReal.includes('【想起来了'), mixReal ? mixReal.split('\n')[0].slice(0, 26) : '(没返回)')
const mixQuote = recallBlock(p5, { query: '你答应过别再拖' })
ok('同一行里复述我的那半 → 降级', !mixQuote || !mixQuote.includes('【想起来了'), mixQuote ? mixQuote.split('\n')[0].slice(0, 26) : '(没返回)')
ok('这时不许说「没有他的原话」（他明明说了别的）', !!mixQuote && !/没有他的原话/.test(mixQuote))
// 框架全中、对象没中：他真说过「明天帮你写完那份配置」，问「明天陪我去看海」不能算。
// 0.2.8 顺手补的：命中里必须带得上问句最后一个内容词（对象）。
const mixOther = recallBlock(p5, { query: '你答应过明天陪我去看海' })
ok('框架全中但对象没中 → 不算', !mixOther || !mixOther.includes('【想起来了'), mixOther ? mixOther.split('\n')[0].slice(0, 26) : '(没返回)')

// 0.2.10：尾巴不能把真承诺拖下水——对象取最后三个实词二元组，有一个在命中段里就算过。
const tailA = recallBlock(p5, { query: '你答应过明天帮我把那套配置写完本身' })
ok('尾巴挂抽象词也算（这件事）', !!tailA && tailA.includes('【想起来了'), tailA ? tailA.split('\n')[0].slice(0, 26) : '(没返回)')
const tailB = recallBlock(p5, { query: '你答应过明天帮我把那套配置写完别催我' })
ok('尾巴挂催促词也算（别催我）', !!tailB && tailB.includes('【想起来了'), tailB ? tailB.split('\n')[0].slice(0, 26) : '(没返回)')
const tailC = recallBlock(p5, { query: '你答应过明天帮我把那套配置写完好不好' })
ok('尾巴挂问句也算（好不好）', !!tailC && tailC.includes('【想起来了'), tailC ? tailC.split('\n')[0].slice(0, 26) : '(没返回)')
// 整个说法换掉（不是只换对象词）仍然降级——这条是固有代价，别当回归
const syn = recallBlock(p5, { query: '你答应过要陪我去做身体检查' })
ok('整套换说法 → 仍降级（固有代价）', !syn || !syn.includes('【想起来了'), syn ? syn.split('\n')[0].slice(0, 26) : '(没返回)')
p5.close()
rmSync(p5Dir, { recursive: true, force: true })

console.log('\n[12] 配置：改坏一次不能清空名单（0.2.13.4）')
// 2026-10-31 实测：config.json 写成半截 JSON 再读一次，workspaces / lines 全变空。
// 多个会话共用这份配置 → 一次手滑，四条线一起失去归属。
// 这里的四条断言钉住：坏了不写盘、退回上一份好的、改好自动恢复、写盘是原子的。
const realHome = process.env.DSH_HOME
const cfgHome = mkdtempSync(join(tmpdir(), 'hippo-cfg-'))
mkdirSync(join(cfgHome, 'dsh-memory'), { recursive: true })
process.env.DSH_HOME = cfgHome
const { loadCfg, saveCfg, CFG_PATH } = await import('./lib/config.mjs')
writeFileSync(CFG_PATH, JSON.stringify({ workspaces: ['D:/keep/me'], lines: [{ name: 'x' }] }), 'utf8')
loadCfg()                                     // 读到好配置 → 留一份 .bak
writeFileSync(CFG_PATH, '{"workspaces": ["D:/broken"]', 'utf8')
const fallback = loadCfg()                    // 写坏了
ok('配置写坏后不丢名单（退回上一份好的）', fallback.workspaces.includes('D:/keep/me') && fallback.lines.length === 1, JSON.stringify(fallback.workspaces))
ok('配置写坏后不覆盖原文件（留给人去改）', readFileSync(CFG_PATH, 'utf8').includes('D:/broken'))
writeFileSync(CFG_PATH, JSON.stringify({ workspaces: ['D:/fixed'], lines: [] }), 'utf8')
ok('改好之后自动恢复', loadCfg().workspaces.includes('D:/fixed'))
saveCfg({ workspaces: ['D:/saved'], lines: [] })
ok('saveCfg 原子写（没有 .tmp 残留）', !existsSync(CFG_PATH + '.tmp') && readFileSync(CFG_PATH, 'utf8').includes('D:/saved'))
if (realHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = realHome
rmSync(cfgHome, { recursive: true, force: true })

console.log('\n[13] 最近也提过：只补一句话，不动排序（0.2.13.9）')
// 2026-11-01 的实况：问「海马体 衰减」，它给 10-31 那段——那段一分半钟说了 28 次，
// 按「哪段最像在说这件事」排第一没毛病；但人会以为今天没聊过。补一句提示，不碰排序。
const rDir = mkdtempSync(join(tmpdir(), 'hippo-recent-'))
const rl = new Ledger(rDir, { meetingGapMs: 60 * 60 * 1000, minTurnsPerEpisode: 2, maxTurnsPerEpisode: 40 }).open()
const NOW_MS = Date.now()
// 先铺无关记录，让 df/N 落到真实量级：只有两段的库里，任何词的 df/N 都是 1，
// 冷词那条判据根本验不出来（假绿）。
const fillA = NOW_MS - 70 * 3600 * 1000
for (let i = 0; i < 40; i++) rl.append({ who: i % 2 ? 'me' : 'he', text: `今天天气不错第${i}句，随便记一句加点字数。`, ts: fillA + i * 10000, sid: 'fillA' })
// 这一批只提「海马体」不提「衰减」：于是「海马体」变成常见词（df/N>0.3），「衰减」还是冷词。
const fillB = NOW_MS - 60 * 3600 * 1000
for (let i = 0; i < 10; i++) rl.append({ who: i % 2 ? 'me' : 'he', text: `海马体这个词第${i}次出现，只提名字不聊细节。`, ts: fillB + i * 10000, sid: 'fillB' })
const denseTs = NOW_MS - 48 * 3600 * 1000
// 老的密段：短而密才排第一（真实情形就是一分半钟里专门讨论）；每条换一个字，免得被去重吞掉。
for (let i = 0; i < 10; i++) {
  rl.append({ who: i % 2 ? 'me' : 'he', text: `海马体衰减第${i}次记录，海马体衰减还要再调。` + (i === 0 ? '这件事只在这里提过一次。' : ''), ts: denseTs + i * 1000, sid: 'old' })
}
const freshTs = NOW_MS - 2 * 3600 * 1000
rl.append({ who: 'he', text: '海马体那个衰减到底调好没有。', ts: freshTs, sid: 'new' })
rl.append({ who: 'me', text: '衰减调完了，海马体这版能跑。', ts: freshTs + 1000, sid: 'new' })
rl.seal(true)
const rA = recallBlock(rl, { query: '海马体 衰减' })
ok('有更近的段提过 → 补一句「也提过」', !!rA && rA.includes('另：') && rA.includes('段 #'), rA ? rA.split('\n')[2] || '(没那句)' : '(没返回)')
ok('提示带段号，能点回去核', !!rA && /段 #\d+/.test(rA))
const rB = recallBlock(rl, { query: '海马体 衰减', sid: 'new' })
ok('当前这场不算「另外提过」', !!rB && !rB.includes('另：'))
const rC = recallBlock(rl, { query: '只在这里提过' })
ok('没有更近的提过 → 不出提示（别变成每回都挂一句）', !!rC && !rC.includes('另：'))
// 只信冷词：这条库里「海马体」出现在每一段（df/N=1），不该拿它当「提过」的证据。
const rD = recallBlock(rl, { query: '海马体' })
ok('查询里全是常见词 → 不出提示', !!rD && !rD.includes('另：'))
// 0.2.13.9 装完当场炸出来的 bug：第一行本身就是最新那段时，它往回挑一段更早的，
// 还说「最近一次是那段」——事实是反的。修法是「候选必须比第一行更新」。
const epNew = rl.episodes.find((e) => e.sid === 'new')
const epOld = rl.episodes.find((e) => e.sid === 'old')
ok('第一行已是最新那段 → 不往回挑', recentMention(rl, '海马体 衰减', epNew, null) === null)
ok('第一行较旧 → 指向更新的那段', !!recentMention(rl, '海马体 衰减', epOld, null))
rl.close()
rmSync(rDir, { recursive: true, force: true })

const ms = Date.now() - t0
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过（${ms} ms）`)
process.exit(fail === 0 ? 0 : 1)