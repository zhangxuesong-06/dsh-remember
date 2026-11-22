import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const modelFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
const maximumCodeUnits = 6400

export async function loadLocalModel(directory) {
  const root = await fs.realpath(path.resolve(directory))
  const files = []
  for (const name of modelFiles) {
    const file = path.join(root, name)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    files.push([name, hash.digest('hex')])
  }
  const config = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'))
  const family = config._name_or_path ?? ''
  const prefix = /\be5\b/i.test(family) ? 'query: ' : ''
  const pooling = /\bbge-m3\b/i.test(family) ? 'cls' : 'mean'
  if (!['bert', 'xlm-roberta'].includes(config.model_type) || !Number.isInteger(config.hidden_size) || config.hidden_size < 1) {
    throw new Error('需要 BERT 或 XLM-RoBERTa ONNX q8 模型目录')
  }
  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.useFSCache = false
  const extractor = await pipeline('feature-extraction', root.split(path.sep).join('/'), {
    dtype: 'q8', device: 'cpu', local_files_only: true, use_external_data_format: false,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  })
  const positionLimit = config.model_type === 'xlm-roberta' ? config.max_position_embeddings - 2 : config.max_position_embeddings
  const maxTokens = Math.min(512, positionLimit || 512, extractor.tokenizer.model_max_length || 512)
  extractor.tokenizer.model_max_length = maxTokens
  return {
    fingerprint: createHash('sha256').update(JSON.stringify([
      'atlas-onnx-single-v1', env.version, process.platform, process.arch, prefix, pooling, maxTokens, maximumCodeUnits, files,
    ])).digest('hex'),
    dimension: config.hidden_size,
    // Symmetric paraphrase and cosine scales are model-specific. Admission still requires offline evaluation.
    threshold: /paraphrase-multilingual/i.test(family) ? 0.35 : pooling === 'cls' ? 0.55 : 0.78,
    async embed(texts) {
      // Dynamic q8 activations can depend on the other texts in a padded batch.
      // Run each unique text alone so its cache key determines its embedding.
      const vectors = []
      for (const text of texts) {
        const result = await extractor(prefix + text.slice(0, maximumCodeUnits), { pooling, normalize: true })
        vectors.push(result.data)
      }
      return vectors
    },
  }
}

