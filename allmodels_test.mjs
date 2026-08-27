import { ProxyAgent, fetch } from 'undici';
const PX = 'http://mnhbqdkj:agftcwgon22n@92.112.90.251:7225';
const KEY = 'sk-bVUwClmPtBH6jwzKh4USNvxxdxiFgobjupngeMT4BJKveaaHKCmOTWIddEwi7Jdg';
const agent = new ProxyAgent(PX);

const res = await fetch('https://opencode.ai/zen/go/v1/models', { headers: { 'Authorization': `Bearer ${KEY}` }, dispatcher: agent });
const j = await res.json();
const models = (j.data || []).map(m => m.id);

for (const m of models) {
  try {
    const r = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({ model: m, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
      dispatcher: agent
    });
    const t = await r.text();
    let status = r.status;
    if (status === 200) console.log(`200  ${m}`);
    else if (status === 429) console.log(`429  ${m} (limit)`);
    else if (status === 500) console.log(`500  ${m}`);
    else console.log(`${status}  ${m}`);
  } catch (e) {
    console.log(`ERR  ${m}: ${e.message.slice(0,40)}`);
  }
}
