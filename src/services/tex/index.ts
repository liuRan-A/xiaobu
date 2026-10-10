/**
 * 小卜 · 贴图服务出口   src/services/tex/index.ts
 * ===========================================================================
 * M3 混合渲染的贴图层入口。只导出加载器相关，不含任何具体贴图 URL ——
 * URL 一律从 config.assets 派生（门禁⑤⑧：无硬编码域 / 无密钥）。
 */
export {
  createTexLoader,
  TexLoader,
  type TexSource,
  type TexStatus,
  type TexLoaderOptions,
} from './loader'
export {
  resolveCardFaceUrl,
  loadCardFace,
  isCardFaceLoaded,
  __test_resetCardFaces,
  __test_cardFaceCacheSize,
  __test_cardFaceDecodes,
} from './cardFaces'
