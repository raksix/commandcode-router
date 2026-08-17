/**
 * Claude Code model adını CommandCode model adına eşle.
 * Öncelik: exact match -> glob-prefix match -> defaultModel -> olduğu gibi.
 */
export function mapModel(model, cfg) {
  if (!model) return cfg.defaultModel ?? model;
  if (cfg.modelMap?.[model]) return cfg.modelMap[model];
  for (const [k, v] of Object.entries(cfg.modelMap ?? {})) {
    if (k.endsWith('*') && model.startsWith(k.slice(0, -1))) return v;
  }
  return cfg.defaultModel ?? model;
}
