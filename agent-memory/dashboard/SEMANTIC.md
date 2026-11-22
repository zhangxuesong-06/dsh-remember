# 星图本地语义近邻 · Windows

星图默认显示全量。关闭右下角「全量星点」或访问 `/?all=0` 可进入 360 点视图。基础视图按来源交错选取近期星点，搜索命中或打开的邻域会临时补入。两种视图共用坐标。已发布位置保存到记忆根目录的 `dashboard/galaxy-positions.json`，初次建立时沿用现行三维布局。

## 安装和离线评测

以下命令在 Windows x64、Node.js `24.19.0`、npm `11.17.0` 验过。首先安装两组锁定依赖。语义依赖单独安装，普通星图只需要第一条 `npm.cmd`。

```powershell
Set-Location -LiteralPath 'C:\Users\HUAWEI\Desktop\work\记忆'
npm.cmd --prefix agent-memory/dashboard ci --ignore-scripts
npm.cmd --prefix agent-memory/dashboard/semantic ci --ignore-scripts
$atlasModel = Join-Path $PWD 'agent-memory\dashboard\semantic\models\paraphrase-multilingual-MiniLM-L12-v2'
```

已有模型时，把 `$atlasModel` 设成该目录的绝对路径。目录需要 `config.json`、`tokenizer.json`、`tokenizer_config.json` 和 `onnx/model_quantized.onnx`。也可以从能联网的机器下载，再拷贝整个目录。支持 BERT / XLM-RoBERTa q8 单文件 ONNX 模型，其他模型同样经过合成验收。以下复制固定版本 MiniLM。默认尝试 Hugging Face，连接失败时重试同一路径的镜像。四个文件通过 SHA‑256 校验后才就位。

```powershell
$atlasRepo = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
$atlasRev = '7e3d5398ff67a776281d0a27b2d47a964d5bfffb'
$atlasFiles = [ordered]@{
  'config.json' = '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7'
  'tokenizer_config.json' = '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2'
  'tokenizer.json' = 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441'
  'onnx/model_quantized.onnx' = '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc'
}
New-Item -ItemType Directory -Force (Join-Path $atlasModel 'onnx') | Out-Null
foreach ($atlasFile in $atlasFiles.Keys) {
  $atlasPath = Join-Path $atlasModel $atlasFile
  if ((Test-Path -LiteralPath $atlasPath) -and (Get-FileHash -LiteralPath $atlasPath).Hash -eq $atlasFiles[$atlasFile]) { continue }
  $atlasPart = "$atlasPath.part"
  $atlasVerified = $false
  foreach ($atlasDomain in 'https://huggingface.co', 'https://hf-mirror.com') {
    curl.exe --fail --silent --show-error --location --connect-timeout 10 --max-time 300 --output $atlasPart "$atlasDomain/$atlasRepo/resolve/$atlasRev/${atlasFile}?download=true"
    if ($LASTEXITCODE -eq 0 -and (Get-FileHash -LiteralPath $atlasPart).Hash -eq $atlasFiles[$atlasFile]) {
      Move-Item -LiteralPath $atlasPart -Destination $atlasPath -Force
      $atlasVerified = $true
      break
    }
  }
  if (-not $atlasVerified) { throw "下载或校验失败：$atlasFile。可从另一台机器拷贝模型目录。" }
}
```

权重 SHA‑256 可用 [上游固定版本](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/commit/7e3d5398ff67a776281d0a27b2d47a964d5bfffb) 核对。安装之后模型从本机读盘，推理路径禁止远程下载。以下评测只用版本库内的合成记录，成功退出码为 `0`。

```powershell
node agent-memory/dashboard/server.mjs --check-semantic "--semantic-model=$atlasModel"
```

## 启动

先打开只含合成记忆的实例。`--port=0` 也可用于选择空闲端口，终端会打印地址。

```powershell
node agent-memory/dashboard/server.mjs --demo --port=7332 "--semantic-model=$atlasModel"
```

正式库由用户主动启动。若原工作台占用 7331，可以沿用旧实例并在另一个端口启动。每次显式启用都会重跑合成验收，合成验收失败会在监听端口前退出。省略模型参数启动普通工作台。

```powershell
node agent-memory/dashboard/server.mjs --port=7333 "--semantic-model=$atlasModel"
```

## 如何读结果

打开一颗星，原话侧栏的「语义近邻 · 推断」最多显示八项。余弦数值表示模型向量接近程度。同轮及原文引用仍列在「账本证据」。语义建议不写账本、标签、坐标或召回排序。DSH 候选限定在同一工作区和同一来源账本，带常见纠正或否定指令的记录、明确实车与仿真冲突以及明确反向坐标变换会被保守排除。以固定留出和明确干扰为验收范围，其他语言措辞仍可能绕过这些规则。

首次点开记录计算所在星图快照的向量，记录越多等待越久。工作台可同时看原话和账本证据。缓存按模型文件和原文的 SHA‑256 分开，位于记忆根目录的 `dashboard/embedding-cache`。磁盘文件保存向量和哈希文件名，向量仍属于派生的私人数据。停用语义后可在工作台停止时移走该缓存，账本原文会保留。
