# PANDUAN INSTALASI & MENJALANKAN — Meridian Multi-User (Progress)

> **⚠️ STATUS SAAT INI: APLIKASI BELUM BISA JALAN END-TO-END.**
> `tools/dlmm.js`, `tools/executor.js`, `tools/screening.js`, `agent.js`,
> `prompt.js`, `telegram.js`, `index.js` MASIH memanggil `state.js`/`lessons.js`/
> `pool-memory.js`/`decision-log.js`/`signal-tracker.js` dengan cara LAMA
> (sinkron, tanpa `telegramId`) — padahal modul-modul itu SUDAH diubah jadi
> `async` dan wajib menerima `telegramId` di sesi migrasi sebelumnya. Ini bukan
> bug baru, ini adalah kondisi WAJAR di tengah migrasi besar yang belum selesai.
> **Jangan jalankan bot di atas wallet/dana nyata sampai poin 2 di bawah selesai
> semua** — akan terjadi error runtime (bukan cuma "kurang fitur").

## 1. Yang SUDAH selesai & teruji (smoke test lulus di `test/*.smoke.js`)

- Database PostgreSQL (Prisma) — semua tabel per `telegramId`: `User`, `Wallet`,
  `UserConfig`, `UserSecret`, `Position`, `PositionEvent`, `DecisionLog`, `Lesson`,
  `PerformanceRecord`, `SignalWeight`, `SmartWallet`, `Strategy`,
  `TokenBlacklistEntry`, `DevBlocklistEntry`, `PoolMemory`/`PoolDeploy`,
  `HiveMindCache`, `BriefingState`.
- Wallet custody: `crypto/wallet-vault.js` — generate wallet Solana asli per user,
  private key dienkripsi AES-256-GCM pakai master key di `secrets/wallet.master.key`
  (permission 600, tidak pernah masuk DB/log).
- Konfigurasi per-user: `config-defaults.js` + `user-config-service.js` — semua
  field dari `config.js`/`user-config.example.json` lama sudah jadi kolom JSON
  per-section di tabel `UserConfig`, dengan default persis sama.
- API key/RPC per-user dienkripsi: `UserSecret` (Helius, RPC URL, LLM key, GMGN key,
  dll — SEMUA biaya API ditanggung user masing-masing).
- Income aplikator (Jupiter referral fee) TETAP di level server, bukan per-user:
  `app-config.js` (`jupiterAppConfig`), sumber dari `.env` (`JUPITER_API_KEY`,
  `JUPITER_REFERRAL_ACCOUNT`, `JUPITER_REFERRAL_FEE_BPS`). Field ini SENGAJA
  tidak ada di `config-defaults.js`/`UserSecret` — ini pendapatan operator, bukan
  milik user.
- Modul state sudah pindah dari file JSON ke Postgres (per `telegramId`, async):
  `state.js`, `pool-memory.js`, `lessons.js`, `signal-weights.js`, `decision-log.js`,
  `strategy-library.js`, `token-blacklist.js`, `dev-blocklist.js`, `smart-wallets.js`,
  `signal-tracker.js` (in-memory, namespaced per user), `hivemind.js`.
- `tools/context.js` — pola `ctx` per-user (`buildUserContext(telegramId)` →
  `{telegramId, user, dryRun, config, secrets, wallet, _connection}`,
  `getConnection(ctx)`, `requireWallet(ctx)`).
- Tool yang SUDAH full migrasi ke pola `ctx` (referensi pola untuk yang lain):
  `tools/wallet.js`, `tools/gmgn.js`, `tools/token.js`, `tools/agent-meridian.js`.

## 2. Yang BELUM selesai (jangan anggap sudah jalan)

- **`tools/dlmm.js`** (~1600 baris, PALING KRITIS — deploy/close/claim posisi,
  transaksi dana nyata) — masih pakai `process.env.WALLET_PRIVATE_KEY`/`RPC_URL`
  single-wallet DAN masih memanggil `state.js`/`lessons.js`/`pool-memory.js`/
  `decision-log.js`/`signal-tracker.js` dengan signature lama (sinkron, tanpa
  `telegramId`) — **ini akan error saat dijalankan** karena fungsi-fungsi itu
  sekarang `async` dan wajib `telegramId`.
- `tools/executor.js` (dispatcher tool) — sama, masih import `config.js` global
  dan meneruskan argumen lama ke modul yang sudah dimigrasi.
- `tools/screening.js`, `tools/ohlcv.js`, `tools/pnl.js`, `tools/study.js`,
  `tools/chart-indicators.js`, `tools/risk/dynamic-stop-loss.js`,
  `tools/risk/onchain-intelligence.js` — masih pakai `config.js` global.
- `agent.js`, `prompt.js` — LLM masih pakai `process.env.LLM_MODEL` global, belum
  per-user; `prompt.js` juga masih import `config.js`.
- `telegram.js` — **belum di-rewrite**, masih 1 chat/1 user (`TELEGRAM_CHAT_ID`,
  `TELEGRAM_ALLOWED_USER_IDS`), belum ada command `/config` atau `/exportkey`.
- `index.js` — **belum di-rewrite**, masih `node-cron` 1 proses untuk 1 wallet,
  belum pakai BullMQ/Redis untuk antrian per-user, dan memanggil fungsi-fungsi
  state lama dengan signature lama juga (akan error saat runtime).
- Redis/BullMQ: Redis sudah terpasang & jalan, tapi **queue/worker belum dibuat**.
- `config.js` lama belum dihapus (masih dipakai file-file di atas — sengaja
  dibiarkan supaya ada satu sumber default yang konsisten sampai migrasi tools
  selesai semua; JANGAN hapus sebelum semua file di atas selesai dimigrasi).

**Kesimpulan:** kerangka database, keamanan wallet, dan konfigurasi per-user
sudah solid dan teruji SECARA TERPISAH. Tapi **rantai eksekusi trading
(dlmm→executor→screening→agent→telegram→index) belum tersambung ulang** ke
kerangka baru ini, dan sebagian modul lama akan ERROR jika dijalankan sekarang
karena dependency-nya sudah berubah signature. Menyambungkan ulang seluruh
rantai ini adalah pekerjaan besar (>2000 baris kode saling terkait) yang harus
dikerjakan sekaligus/berurutan ketat di sesi lanjutan — TIDAK bisa dicicil per
file tanpa membuat aplikasi sempat dalam keadaan rusak di antaranya.


## 3. Instalasi (untuk melanjutkan development)

### 3.1 Prasyarat
- Node.js ≥ 18 (server ini pakai v22)
- PostgreSQL (sudah jalan di `127.0.0.1:5432`, database `meridian`, user `meridian`)
- Redis (sudah terpasang & aktif — `systemctl status redis-server`)

### 3.2 Install dependency
```bash
cd meridian-upgrade-indicator
npm install
```
Perintah ini otomatis menjalankan `prisma generate` (lihat `postinstall` di
`package.json`).

### 3.3 Siapkan `.env`
Salin `.env.example` ke `.env`, lalu isi:
```bash
cp .env.example .env
```
Wajib diisi (level server, BUKAN per-user):
- `TELEGRAM_BOT_TOKEN` — token bot dari @BotFather.
- `DATABASE_URL` — sudah default ke `meridian` lokal, ganti password bila perlu.
- `REDIS_URL` — default `redis://127.0.0.1:6379`.
- `WALLET_MASTER_KEY_PATH` — default `./secrets/wallet.master.key` (dibuat
  otomatis saat pertama kali dipakai, JANGAN dihapus/commit ke git).
- `JUPITER_API_KEY`, `JUPITER_REFERRAL_ACCOUNT`, `JUPITER_REFERRAL_FEE_BPS` —
  ini pendapatan aplikator (operator), bukan milik user.

### 3.4 Migrasi database
```bash
npx prisma migrate deploy   # jalankan migration yang sudah ada
npx prisma studio           # opsional: GUI untuk lihat isi database
```

### 3.5 Menjalankan smoke test (verifikasi bagian yang sudah selesai)
```bash
node test/test-user-config-service.smoke.js
node test/test-pool-memory.smoke.js
node test/test-state.smoke.js
node test/test-lessons.smoke.js
```
Semua harus selesai tanpa error dan diakhiri `cleanup ok`.

### 3.6 Menjalankan bot (⚠️ BELUM multi-user penuh)
```bash
npm start
```
Ini masih menjalankan `index.js` versi LAMA (single-wallet, baca `WALLET_PRIVATE_KEY`
dari `.env`). Jangan pakai untuk banyak user sampai langkah di bagian 2 selesai.

## 4. Rencana lanjutan (urutan mengerjakan sisa migrasi)

1. Migrasi `tools/dlmm.js` ke pola `ctx` (paling kritis: deploy/close/claim posisi).
2. Migrasi `tools/executor.js` (teruskan `ctx` ke semua tool handler).
3. Migrasi `tools/screening.js`, `token.js`, `gmgn.js`, `ohlcv.js`, `pnl.js`,
   `study.js`, `agent-meridian.js`, `chart-indicators.js` ke `ctx`.
4. Migrasi `agent.js` + `prompt.js` (LLM key/model per user).
5. Buat `queue/redis.js`, `queue/queues.js`, `queue/workers.js` (BullMQ per
   `telegramId`, satu proses Node, worker in-process — sesuai keputusan skala
   "ratusan user, 1 process").
6. Rewrite `index.js`: scheduler BullMQ per user aktif (`listActiveUsers()`),
   hapus `node-cron` versi lama.
7. Rewrite `telegram.js`: registrasi bebas (`ensureUser` saat `/start`),
   command `/config` (wizard per kategori), command `/exportkey` (wajib
   konfirmasi eksplisit dari user sebelum private key ditampilkan), semua
   command difilter berdasarkan `telegramId` pengirim.
8. Hapus `config.js` setelah semua file di atas tidak lagi mengimpornya.
9. Update panduan ini jadi versi final setelah semuanya selesai.

## 5. Catatan keamanan penting

- **Admin server TIDAK PERNAH melihat private key asli** lewat database atau UI
  manapun — hanya ciphertext. Private key hanya bisa dibuka lewat command
  `/exportkey` di bot (setelah command ini selesai dibuat) dan hanya oleh
  `telegramId` pemilik wallet tersebut.
- Jangan pernah commit folder `secrets/` atau file `.env` ke git (sudah
  di-gitignore).
- Biaya API (Helius, LLM, GMGN, dll) ditanggung masing-masing user lewat
  `/config` — server tidak menanggung biaya ini.
