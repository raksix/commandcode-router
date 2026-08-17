# CommandCode Router

Anthropic API uyumlu bir proxy. Claude Code (veya herhangi bir Anthropic SDK), senin ürettiğin **master API key** ile proxy'ye bağlanır; proxy ise istekleri bir **CommandCode API key havuzuna round-robin** dağıtır. Yani 10 hesap eklersen, 10 key otomatik dönüşümlü kullanılır. Bir hesap hata verirse sıradakine geçer, çok hata verirse otomatik banlanır.

```
Claude Code ──(masterKey)──► Router ──(round-robin)──► CommandCode hesap 1
   (Anthropic formatı)         :3000  ├──► CommandCode hesap 2
                                     ├──► ...
                                     └──► CommandCode hesap 10
```

## Özellikler

- **Anthropic uyumlu endpoint** — `POST /v1/messages`, `GET /v1/models` (SSE streaming dahil)
- **OpenAI uyumlu endpoint** — `POST /v1/chat/completions`
- **Round-robin dağıtım** — her istek sıradaki hesaba gider (restart'ta sıra korunur)
- **Auto-fallback** — 401/429/5xx'te sıradaki hesaba geçer (max 2 retry)
- **Otomatik ban** — ardışık 5 hata sonrası hesap devre dışı kalır, panelden kaldırılır
- **Web paneli** — hesap ekle/sil/test, master key üret/yenile, model eşleme, sayaçlar
- **Model eşleme** — Claude Code'un gönderdiği `claude-...` adlarını CommandCode modellerine eşler

## Kurulum

```bash
cd C:\Users\raksi\commandcode-router
npm install
npm start
```

İlk açılışta `config.json` otomatik üretilir ve konsola **Master API Key** + **Admin şifresi** yazılır. Bu değerleri kaydet (sonradan panelden de görebilirsin).

## Kullanım

1. Tarayıcıdan `http://localhost:3000` aç, admin şifresiyle gir.
2. **Hesaplar** bölümünden CommandCode API key'lerini ekle (`+ Hesap Ekle`). Her key bir "hesap".
3. Her hesabı **Test** butonuyla doğrula (CommandCode'dan model listesi çeker).
4. **Master API Key** kartındaki key'i Claude Code'a bağla.

### Claude Code bağlama

```bash
# proje bazlı .env veya global ayarlar (settings.json env bloğu)
ANTHROPIC_BASE_URL=http://localhost:3000
ANTHROPIC_AUTH_TOKEN=<masterKey>
```

> ⚠️ `ANTHROPIC_BASE_URL` sonuna `/v1` **EKLEME** — Claude Code kendisi `/v1/messages` ekler.

Modeli netleştirmek istersen istemci tarafında override edebilirsin:
```bash
ANTHROPIC_MODEL=deepseek/deepseek-v4-flash
```

### cURL ile test

```bash
curl http://localhost:3000/v1/models -H "Authorization: Bearer <masterKey>"

curl -X POST http://localhost:3000/v1/messages \
  -H "Authorization: Bearer <masterKey>" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"selam"}]}'
```

## Model Eşleme

Claude Code `claude-sonnet-4-5` gibi adlar gönderir; CommandCode `claude-sonnet-5` veya `deepseek/deepseek-v4-flash` gibi adlar bekler. Paneldeki **Model Eşleme** tablosundan eşlersin:

| İstemcinin gönderdiği | CommandCode modeli |
|---|---|
| `claude-sonnet-4-*` | `claude-sonnet-5` |
| `claude-haiku-4-*` | `claude-haiku-4-5-20251001` |
| `claude-opus-4-*` | `claude-opus-5` |

Tanımayan her istek **Varsayılan model**'e düşer. Eşleşmeyen model adı gönderilirse CommandCode "model not supported" hatası verir — o zaman panele doğru eşleme ekle.

> 💡 CommandCode'un model listesini `GET /v1/models` ile görüntüleyebilirsin. Bazı modeller (örn. `claude-sonnet-5`, `claude-opus-5`) **Provider planı** gerektirir; Go planı hesaplarında `deepseek/...` veya OpenAI formatı gerekebilir.

## Yapılandırma (config.json)

| Alan | Açıklama |
|---|---|
| `port` | Sunucu portu (varsayılan 3000) |
| `masterKey` | İstemcilerin kullandığı API key |
| `adminPassword` | Web paneli şifresi |
| `accounts` | CommandCode key havuzu |
| `modelMap` | Model eşleme tablosu |
| `defaultModel` | Tanımayan isteklerin düştüğü model |
| `retry.maxRetries` | Hata sonrası sıradaki hesaba geçiş sayısı (2) |
| `retry.banAfter` | Otomatik ban eşiği (5 ardışık hata) |

## Güvenlik Notları

- API key'ler `config.json` içinde **düz metin** durur (`.gitignore`'da, localhost kullanımı için kabul edilir).
- `/v1/*` mutlaka masterKey ister.
- Web paneli ayrı admin şifresi + HttpOnly cookie (5 dk oturum).
- Sistemi internete açarsan mutlaka önüne bir auth katmanı koy.

## Sorun Giderme

- **`Model "X" is not supported on this endpoint`** → Model eşleme tablosuna doğru CommandCode model adını ekle.
- **`permission_error` / "Your Go plan doesn't include API access"** → O CommandCode hesabı API erişimine açık değil (Provider planı gerekebilir). Başka bir hesap/key dene veya test et.
- **Port dolu** → `netstat -ano | grep 3000` ile süreci bul, kapat, tekrar `npm start`.
