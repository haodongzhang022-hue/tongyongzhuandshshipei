# 插件接入模板（拷贝即用）

```
cp templates/adapter/index.mjs <你的插件仓库>/index.mjs
cp templates/adapter/package.json.fragment <你的插件仓库>/   # 合并进现有 package.json
```

`index.mjs` 里的 `demo_*` 工具名替换成你自己的（**建议带 prefix**，规避 DSH 保留名 `run_code`）。

完整说明见 `docs/ADAPTER_GUIDE.md`。
