# 方法词表 → kgnav

方法名和别名只在记忆侧维护。四个 harness 共用共享根目录下独立的 `methods.json`；
命令不加载检索器、不探测或读取原文库。`--root` 可显式指定，默认取
`AGENT_MEMORY_HOME` 或 `~/.agent-memory`，**不是** `OPENCODE_MEM_HOME`。

## 显式维护

```bash
node agent-memory/methods.mjs set 手眼标定 handeye calibrateHandEye "hand eye"
node agent-memory/methods.mjs set 幂等 idempotent
node agent-memory/methods.mjs set Dijkstra
node agent-memory/methods.mjs list
node agent-memory/methods.mjs remove Dijkstra
```

`set` 新建或替换整组，不追加旧别名；所以纠正、删除过期写法后重导出即可。
每个别名单独一个参数，有空格的加引号；不按空格/逗号再次拆分。
规范名自动纳入匹配词；空白修剪，大小写重复只留一份。源表与输出都是普通 JSON，
但日常建议用命令维护，避免并发覆盖。维护复用 journal 锁及原子更新。

这张表只放**明确选择为方法**的词。既有 `alias` 命令与 `aliases.json` 继续表示普通同义词；
不会因为一组词长得像方法就迁移，也不从 `assoc.json` 的 PMI 或查询共现中取词。
命令的显式执行才是登记行为，模型不应自行决定哪些词该升级为方法。

## 导出与消费

```bash
# 在记忆插件仓库运行；输出必须在共享根目录外
node agent-memory/methods.mjs export --out <导出目录>/methods.json

# 在 kgnav 仓库运行；mem-home 须由使用者明确选择
python from_memory.py --mem-home <选定的记录目录> --methods <导出目录>/methods.json
python cli.py --about r1 --graph mem_graph.json --no-log
python cli.py --method 手眼标定 --graph mem_graph.json --no-log
```

导出格式沿用 kgnav 的契约，无包装层或标签字段：

```json
{"手眼标定": ["手眼标定", "handeye", "calibrateHandEye", "hand eye"]}
```

kgnav 只消费导出快照，不再手改它或在两边抄表。源表变更后须重新导出、重新抽图；
没有文件监听或自动同步。缺失/非法源表会以退出码 2 拒绝导出，已有输出保留；
导出本身不会创建源表、索引、日志或锁。空对象是明确的空表，可以导出。

kgnav 仍按**大小写不敏感的子串**匹配记录，保留命中词作为证据。
因此“提到方法”不证明“实际使用方法”，宽泛或歧义别名仍可能误命中；
每个方法超过 40 个记录节点时 kgnav 会整组跳过，未命中的方法也不建枢纽。
方法词面边不等于语义关系；共现是注意力证据，仍单列且可关闭；
手工标签只接受使用者另行提供的 `tags.json`，本功能不会生成它。

## 只用仓库合成数据验证

需要 Node.js 和 Python 标准库，无新依赖。以下验证不读取任何私人记忆：

```bash
node --test agent-memory/methods.test.mjs
node agent-memory/test-kgnav.mjs --kgnav <kgnav源码目录>
# Python 命令若叫 python3：末尾加 --python python3
```

测试从 `fixtures/method-*.json` 生成独立临时源库，并只复制 kgnav 的五个 Python 源码文件，
不接触其本机 `data/mem_graph.json`、标签和查询日志。
它实际执行“导出 → `from_memory.py --methods` → `--about r1` 成员展开 → `--method` → 双记录路径”，
再验证 `--no-method`、`--no-cooccur` 和方法枢纽自身的邻域。
普通同义词与 PMI 诱饵不进方法，图没有自动标签或语义边；
临时源目录逐文件 SHA-256 不变，查询不写日志，临时目录最终清理。
