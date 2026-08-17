/**
 * Claude Code model adını CommandCode model adına eşle.
 * Öncelik: exact match -> glob-prefix match -> CommandCode listesinde varsa olduğu gibi -> defaultModel.
 *
 * Önemli: CommandCode'un KENDİ model adı (deepseek/deepseek-v4-flash, claude-sonnet-5 gibi)
 * gelirse asla defaultModel'e çevrilmez — olduğu gibi geçer.
 * (Aksi halde deepseek isteği yanlışlıkla claude-sonnet-5'e dönüşüp 400/404 veriyordu.)
 */
export function mapModel(model, cfg, state) {
  if (!model) return cfg.defaultModel ?? model;
  if (cfg.modelMap?.[model]) return cfg.modelMap[model];
  for (const [k, v] of Object.entries(cfg.modelMap ?? {})) {
    if (k.endsWith('*') && model.startsWith(k.slice(0, -1))) return v;
  }
  // CommandCode'un bilinen model listesinde varsa (cache) → olduğu gibi geç
  try {
    const cached = state?.modelsCache?.data;
    if (cached) {
      const ids = (JSON.parse(cached).data ?? []).map((m) => m.id);
      if (ids.includes(model)) return model;
    }
  } catch {}
  return cfg.defaultModel ?? model;
}
