# 多语数据集 + MNN 量化嵌入管线(状态文档)
生成时间:2026-08-24T15:39:37.015Z

## 目标
- 自建生产级多语语料(简中 50% / 英 25% / 日 7.5%(ACG)/ 俄 5% / 西葡 5% / 韩 3.5% / 法 3.5% / 繁中 0.5%)
- Jasper-Token-Compression-600M(中文)+ microsoft/harrier-oss-v1-0.6b(多语)经 MNN calibration-aware 量化 int8,CPU 推理
- semble 检索重写(后续)

## 已完成
- notemap 0.11.3(倒排索引 autoLinkSemantic 10x)已发布部署 b02 HTTP 200
- THUCNews 5725 条缓存:benchmark/data/thucnews-real.jsonl
- 真实数据跑分 bench-real.mjs:searchFused vs searchNodes(THUCNews,240 查询)
  - fused recall@10 0.908→1.000(+10%),BFS 语义边增量小(+1.2%,新闻同质)
- 本机环境:Python 3.13.13,已装 MNN + sentence-transformers + onnx + optimum + huggingface_hub
- harrier-oss-v1-0.6b 下载+加载验证成功(sentence_embedding 1024 维)
- Jasper 定位:infgrad/Jasper-Token-Compression-600M(qwen3 系)
- wiki 主题对齐抓取:v3 成功落盘 wiki-zh.jsonl(71 条,含 langlinks 主题映射);en 5 条, ja 4 条
- 数据整合脚本:benchmark/build-corpus.mjs(合并 wiki 主题+random+THUCNews -> corpus-v1.jsonl+manifest)

## 进行中(后台 job)
- wiki random 补量:benchmark/dataset-fetch-random.mjs(8 语言配额 zh2500/en1800/ja600/ru400/es400/pt300/ko250/fr250),输出 wiki-random-<lang>.jsonl(断点续抓,可重复运行)

## 卡点(待解决)
1. **ONNX 导出失败**:torch 2.9 新导出器 bug(_compat import 失败);dynamo=False legacy 导出也在 qwen3 cache_position 处失败(未见最终 traceback)。
   备选: pip install onnxscript(修新导出器)/ 降级 torch 2.6 / 用 optimum-cli export onnx
2. **wiki 主题抓取不稳定**:zh 第一轮 API 偶发返回无 query(需重试增强)。random 补量已绕过。
3. **danbooru tags 406 被拒**(需认证)—— ACG 术语改用 wiki 主题中的 ACG 条目(火影/初音/VOCALOID 等 12 个主题)。
4. **筆電 RTX 3060 不可达**(192.168.0.106:22 不通,需开机+开 SSH)。本机 RX 9060 XT 为备选(MNN OpenCL 后端)。

## 下一步(续接顺序)
1. random job 完成后:node benchmark/build-corpus.mjs 产出 corpus-v1.jsonl(+manifest 语言占比)
2. ONNX 导出修复:优先 pip install onnxscript 重试新导出器;或 torch==2.6 降级;成功则 MNNConvert -f ONNX + mnnquant(校准数据=corpus-v1 采样)
3. 量化后:benchmark/quant/embed-corpus.py(MNN Python 批量嵌入 -> npy)-> 导入 notemap embedding 列(searchVector 已有 provider 接口)
4. 跑分:bench-multiling.mjs(跨语言主题簇 gt:同 theme 多语言条目;查询=单语言 title 片段;对比 plain/fused/vector)
5. 语言占比复核 manifest,不足语言用 random 配额微调

## 关键路径
- 插件:C:/Users/snow/.dsh-starter/plugins/dsh-notemap/src/graph.ts(searchFused/searchVector/autoLinkSemantic)
- 数据:benchmark/data/{raw/,thucnews-real.jsonl,corpus-v1.jsonl}
- 量化:benchmark/quant/export_onnx.py;MNN 文档 https://mnn-docs.readthedocs.io/en/latest/tools/compress.html
- HF token 已注入 export_onnx.py(HF_TOKEN env);HF_HOME=C:\Users\snow\.hf
- b02 生产服务 /home/b02/.dsh/profiles/web/node_modules/@snow-the/dsh-notemap