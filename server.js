import { load, markDirty, flushNow, data } from './src/store.js';
import { createApp } from './src/app.js';

async function main() {
  await load();

  const app = createApp();
  const port = data.config.port || 3000;

  app.listen(port, () => {
    console.log(`\nCommandCode Router çalışıyor:  http://localhost:${port}`);
    console.log(`Admin panel:                      http://localhost:${port}/`);
    console.log(`Anthropic uyumlu API:             http://localhost:${port}/v1`);
    console.log('Claude Code bağlama:');
    console.log(`  ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log(`  ANTHROPIC_AUTH_TOKEN=<masterKey>\n`);
  });

  // flush state on shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await flushNow();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Başlatma hatası:', err);
  process.exit(1);
});
