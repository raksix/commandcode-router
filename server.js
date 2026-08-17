import { createServer } from 'node:http';
import { load, markDirty, flushNow, data } from './src/store.js';
import { createApp } from './src/app.js';
import { createCallbackHandler, CALLBACK_PORT, CALLBACK_PATH } from './src/ccauth.js';

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

  // CommandCode CLI auth callback sunucusu (ana porttan ayrı)
  const callbackServer = createServer(createCallbackHandler());
  callbackServer.listen(CALLBACK_PORT, () => {
    console.log(`CommandCode auth callback:  http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`);
    console.log('  (CommandCode tarayıcı akışı key\'i buraya POST eder)\n');
  });
  callbackServer.on('error', (err) => {
    console.error(`Callback sunucusu (${CALLBACK_PORT}) başlatılamadı:`, err.message);
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
