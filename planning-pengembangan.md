Baik, saya perbaiki fokusnya. Karena kita masih di tahap single user, prioritasnya berbeda. Berikut prompt yang sesuai untuk **maksimalisasi versi single user saat ini**, berdasarkan kode Meridian yang existing dan kebutuhan yang sudah kita diskusikan.

---

# Prompt Implementasi Peningkatan Single User - Meridian

```
Halo Claude, saya butuh bantuan untuk meningkatkan proyek Meridian (https://github.com/yunus-0x/meridian) versi single user saat ini. 

## KONTEKS PROYEK
- Proyek: Meridian - Autonomous DeFi Agent untuk Meteora DLMM
- Status: Single user, self-hosted
- Bahasa: TypeScript/JavaScript (Node.js)
- Dependencies: @meteora-ag/dlmm, @solana/web3.js, openrouter-sdk
- Struktur: Monolith dengan 2 agen (Screening tiap 30 menit, Management tiap 10 menit)

## TUJUAN IMPLEMENTASI
Meningkatkan performa dan keamanan versi single user saat ini, fokus pada:
1. Entry timing yang lebih akurat (Technical Analysis)
2. Proteksi modal yang lebih baik (Dynamic Stop-Loss)
3. Deteksi risiko lebih dini (On-Chain Intelligence)
4. Stabilitas sistem (Circuit Breaker & Retry)

---

## PRIORITAS 1: TECHNICAL ANALYSIS UNTUK ENTRY & EXIT

**Masalah Saat Ini:**
Screening dan management Meridian murni berbasis data on-chain. Tidak ada RSI, MACD, support/resistance, atau volume analysis. Ini menyebabkan sering salah timing entry.

**Yang Harus Ditambahkan:**

### A. Indikator Teknikal
**File yang perlu dibuat:**
- `src/utils/indicators/rsi.ts` - Hitung RSI
- `src/utils/indicators/macd.ts` - Hitung MACD  
- `src/utils/indicators/support-resistance.ts` - Deteksi support/resistance

**Spesifikasi:**
```typescript
// rsi.ts - Hitung RSI dari array harga close
function calculateRSI(closes: number[], period: number = 14): number {
    // RSI = 100 - (100 / (1 + RS))
    // RS = Average Gain / Average Loss selama periode
    // Return 0-100
}

// macd.ts - Hitung MACD, Signal, Histogram
function calculateMACD(closes: number[]): {
    macd: number;
    signal: number;
    histogram: number;
} {
    // MACD = EMA(12) - EMA(26)
    // Signal = EMA(9) dari MACD
    // Histogram = MACD - Signal
}

// support-resistance.ts
function findSupportResistance(
    ohlcv: OhlcvData[], 
    window: number = 20
): { support: number | null; resistance: number | null } {
    // Cari local min (support) dan local max (resistance)
    // Hanya ambil level terdekat dengan harga saat ini
}
```

### B. Parameter di user-config.json
Tambahkan di bagian screening dan management:
```json
{
  "technicalAnalysis": {
    "enabled": true,
    "rsi": {
      "period": 14,
      "overboughtThreshold": 70,
      "oversoldThreshold": 30
    },
    "macd": {
      "fastPeriod": 12,
      "slowPeriod": 26,
      "signalPeriod": 9
    },
    "volume": {
      "spikeMultiplier": 2.0,
      "declineThreshold": 0.5
    },
    "supportResistance": {
      "enabled": true,
      "windowPeriods": 20
    }
  }
}
```

### C. Integrasi ke Screening (Entry)
Di `screening.ts`, setelah dapet kandidat pool:
1. Ambil OHLCV dari Birdeye API (atau source yang tersedia)
2. Hitung RSI, MACD, support/resistance
3. Tambahkan ke skor:
   - RSI < 30 (oversold) → +10 point
   - Harga dekat support → +10 point
   - MACD bullish cross → +5 point
   - Volume spike 2x → +5 point (konfirmasi breakout)

### D. Integrasi ke Management (Exit)
Di `management.ts`, setiap evaluasi posisi:
1. Cek RSI > 70 (overbought) → sinyal exit
2. Cek breakdown support → sinyal exit
3. Cek volume decline > 50% → sinyal exit (exhaustion)
4. Gabungkan dengan sinyal lain untuk keputusan CLOSE

---

## PRIORITAS 2: DYNAMIC STOP-LOSS (ATR-BASED)

**Masalah Saat Ini:**
Stop-loss statis (-15%) tidak cocok untuk semua kondisi pasar. Di pasar volatil, stop-loss terlalu ketat (sering kena). Di pasar stabil, stop-loss terlalu longgar.

**Yang Harus Ditambahkan:**

### A. ATR Calculator
**File:** `src/utils/indicators/atr.ts`
```typescript
function calculateATR(ohlcv: OhlcvData[], period: number = 14): number {
    // True Range = max(high - low, |high - prevClose|, |low - prevClose|)
    // ATR = rata-rata True Range selama periode
}
```

### B. Dynamic Stop-Loss
**File:** `src/management/stop-loss.ts`
```typescript
class DynamicStopLoss {
    // Stop-loss = currentPrice - (ATR × multiplier)
    // multiplier default 1.5 (bisa di-config)
    calculate(
        entryPrice: number, 
        currentPrice: number, 
        atr: number, 
        multiplier: number = 1.5
    ): number {
        return currentPrice - (atr * multiplier);
    }
}
```

### C. Parameter di user-config.json
```json
{
  "riskManagement": {
    "stopLossATRMultiplier": 1.5,
    "atrPeriod": 14,
    "minStopLossPct": -5,
    "maxStopLossPct": -30
  }
}
```

### D. Integrasi ke Management
Di `management.ts`:
1. Hitung ATR dari OHLCV 15 menit
2. Hitung dynamic stop-loss = currentPrice - (ATR × multiplier)
3. Bandingkan dengan stop-loss statis (ambil yang paling ketat)
4. Jika harga menyentuh stop-loss → force CLOSE

---

## PRIORITAS 3: ON-CHAIN INTELLIGENCE (SMART MONEY + HOLDER)

**Masalah Saat Ini:**
Meridian punya `maxTop10Pct` dan `maxBotHoldersPct`, tapi tidak ada tracking Smart Money flow atau dev wallet activity.

**Yang Harus Ditambahkan:**

### A. GMGN Skills Integration (Opsional, jika user punya API key)
**File:** `src/integrations/gmgn/client.ts`
```typescript
class GmgnClient {
    constructor(apiKey: string) {}
    
    // Data holder
    async getTokenInfo(address: string): Promise<{
        holderCount: number;
        top10Concentration: number;
        top50Concentration: number;
        devHoldings: number;
    }>
    
    // Smart money flow (net buy/sell)
    async getSmartMoneyFlow(address: string): Promise<{
        netBuyUsd: number;
        netSellUsd: number;
    }>
}
```

### B. Parameter di user-config.json
```json
{
  "onChainIntelligence": {
    "enabled": false,  // default false, user enable jika punya GMGN API key
    "smartMoney": {
      "minNetBuyUsd": 50000,
      "maxNetSellUsd": 30000,
      "timeWindowMinutes": 5
    },
    "holderConcentration": {
      "maxTop10Pct": 60,
      "maxTop50Pct": 80,
      "alertWhaleDump": true,
      "whaleDumpThresholdPct": 5
    },
    "devWallet": {
      "maxDevHoldingsPct": 10,
      "monitorActivity": true,
      "cooldownHours": 24
    }
  }
}
```

### C. Integrasi ke Screening & Management
**Screening (Entry):**
- Jika GMGN enabled, cek:
  - Top 10 holder > 60% → tolak (risiko manipulasi)
  - Dev holdings > 10% → tolak
  - Smart Money net buy > $50k → +10 point

**Management (Exit):**
- Jika GMGN enabled, cek:
  - Smart Money net sell > $30k dalam 5 menit → sinyal exit
  - Top 10 holder turun 5%+ dalam 1 jam → sinyal exit (whale dumping)

---

## PRIORITAS 4: CIRCUIT BREAKER & RETRY

**Masalah Saat Ini:**
Jika API (RPC, OpenRouter, Meteora API) bermasalah, agent bisa crash atau stuck.

**Yang Harus Ditambahkan:**

### A. Circuit Breaker
**File:** `src/utils/circuit-breaker/circuit-breaker.ts`
```typescript
class CircuitBreaker {
    private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
    private failures = 0;
    private readonly failureThreshold = 3;
    private readonly timeout = 30000; // 30 detik
    private nextAttempt: number = 0;

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        // CLOSED: normal operation
        // OPEN: skip, throw error
        // HALF_OPEN: test one request
    }
}
```

### B. Retry with Backoff
**File:** `src/utils/circuit-breaker/with-retry.ts`
```typescript
function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 1000
): Promise<T> {
    // Exponential backoff: 1s, 2s, 4s
    // Specific handling untuk rate limit (429) dan timeout
}
```

### C. Integrasi ke Existing Code
Bungkus semua panggilan API di:
- `screening.ts`: Meteora SDK, Pool Screening API, Jupiter API
- `management.ts`: Meteora PnL API, RPC calls
- Agent harness: OpenRouter API calls

---

## PRIORITAS 5: TRANSACTION CONFIRMATION

**Masalah Saat Ini:**
Meridian hanya mendapat signature dan langsung menganggap sukses. Transaksi confirmed belum tentu finalized (bisa fork).

**Yang Harus Ditambahkan:**

### A. Confirmation Function
**File:** `src/execution/confirmation.ts`
```typescript
async function confirmTransaction(
    connection: Connection,
    signature: string,
    timeout: number = 60000
): Promise<'finalized' | 'confirmed' | 'timeout' | 'failed'> {
    // Subscribe ke WebSocket Solana
    // Tunggu sampai status finalized atau timeout
    // Return status
}
```

### B. Integrasi ke Management
Di `management.ts`:
1. Kirim transaksi CLOSE atau DEPLOY seperti biasa
2. Dapat signature
3. Panggil `confirmTransaction` dengan signature
4. Jika status = 'finalized' → update posisi/status
5. Jika status = 'failed' atau 'timeout' → retry dengan priority fee lebih tinggi

### C. Priority Fee Logic
**File:** `src/execution/priority-fee.ts`
```typescript
async function calculatePriorityFee(connection: Connection): Promise<number> {
    // Ambil recent prioritization fees
    // Hitung median
    // Return 2x median untuk ensure inclusion
}
```

---

## FORMAT OUTPUT YANG DIHARAPKAN

Untuk setiap prioritas, tolong berikan:
1. Penjelasan singkat pendekatan implementasi
2. Kode lengkap untuk setiap file yang disebutkan
3. Contoh integrasi dengan kode existing Meridian
4. Konfigurasi yang perlu ditambahkan ke `.env` atau `user-config.json`
5. Catatan untuk testing

## BATASAN & CATATAN

1. **Jangan berhalusinasi:** Jika ada API yang tidak kamu tahu persis formatnya, tulis sebagai TODO.
2. **Jangan asumsi:** Semua kode harus berdasarkan fakta dari kode Meridian yang ada.
3. **Prioritas:** Kerjakan sesuai urutan 1-5. Prioritas 4-5 adalah fondasi stabilitas.
4. **Bahasa:** Kode dalam TypeScript, komentar dalam bahasa Indonesia.
5. **Single User:** Semua implementasi harus tetap support single user self-hosted.

## REFERENSI
- Dokumentasi Meteora DLMM SDK: https://docs.meteora.ag
- Kode Meridian: https://github.com/yunus-0x/meridian
- Solana Web3.js: https://solana-labs.github.io/solana-web3.js/

Mulai dari Prioritas 1 ya, Claude. Terima kasih!
```

---

## 📊 Perbedaan dengan Prompt Sebelumnya

| Aspek | Sebelumnya | Sekarang (Single User) |
|-------|-----------|------------------------|
| Target User | Ratusan/ribuan user | Single user self-hosted |
| Arsitektur | Microservices + Queue | Monolith (existing) |
| Multi-Strategy | ✅ Ada | ❌ Dihapus (belum perlu) |
| Position Sizing | ✅ Ada | ❌ Dihapus (belum perlu) |
| Notifications | ✅ Ada | ❌ Dihapus (belum perlu) |
| **Prioritas** | 7 prioritas | **5 prioritas** |
| Fokus | Skalabilitas | **Performance & Profitability** |

Dengan prompt ini, Claude akan fokus pada **peningkatan performa trading** tanpa over-engineering untuk skala besar. 🚀

---

# Versi Revisi Prompt (Selaras 100% Dengan Kode Repo Saat Ini)

Catatan penting:
- Repo ini memakai JavaScript ESM (bukan TypeScript src-based).
- File inti saat ini berada di root dan folder tools.
- Dilarang menghapus fungsi existing. Semua perubahan harus additive atau non-breaking refactor.

Prompt revisi siap pakai:

Halo Claude, saya butuh bantuan pengembangan lanjutan proyek Meridian pada repository lokal saat ini.

KONTEKS FAKTUAL KODE SAAT INI
- Entry daemon: index.js
- Agent loop: agent.js
- Screening logic: tools/screening.js
- Deterministic management rules: index.js dan state.js
- Tool execution + safety gate: tools/executor.js
- On-chain deploy/claim/close: tools/dlmm.js
- Wallet/swap: tools/wallet.js
- Token intel: tools/token.js
- GMGN integration dasar: tools/gmgn.js
- Indicator preset existing: tools/chart-indicators.js
- Config loader: config.js
- User config example: user-config.example.json

TUJUAN PENGEMBANGAN
Fokus peningkatan single-user self-hosted:
1) Entry timing lebih akurat (TA)
2) Proteksi modal lebih adaptif (dynamic stop-loss)
3) Deteksi risiko on-chain lebih dini
4) Ketahanan sistem API/network (retry + circuit breaker)
5) Konfirmasi transaksi lebih ketat

KONSTRAN WAJIB
1. Jangan hapus fungsi existing.
2. Jangan ubah public behavior lama kecuali benar-benar diperlukan, dan harus backward compatible.
3. Jika API eksternal tidak pasti, beri TODO jelas, jangan asumsi.
4. Semua perubahan harus berbasis file dan alur yang benar-benar ada di repo ini.
5. Bahasa penjelasan: Indonesia.

PRIORITAS 1 - TECHNICAL ANALYSIS ENTRY/EXIT (ADDITIVE)

Target implementasi:
- Tambahkan util indikator lokal baru (JavaScript ESM):
  - tools/indicators/rsi.js
  - tools/indicators/macd.js
  - tools/indicators/support-resistance.js
- Tambahkan util fetch OHLCV pool:
  - tools/ohlcv.js
  - Gunakan endpoint yang sudah relevan dengan stack saat ini. Jika endpoint final belum tervalidasi, beri TODO terstruktur.
- Tambahkan config baru tanpa memutus key lama:
  - technicalAnalysis.enabled
  - technicalAnalysis.rsi.*
  - technicalAnalysis.macd.*
  - technicalAnalysis.volume.*
  - technicalAnalysis.supportResistance.*

Integrasi:
- Screening:
  - Integrasi scoring tambahan di tools/screening.js setelah kandidat lolos hard filter existing.
  - TA score bersifat additive terhadap scoreCandidate/degenScore, bukan menggantikan total pipeline lama.
- Management:
  - Tambahkan sinyal TA sebagai sinyal tambahan close di jalur deterministic (index.js/state.js), tanpa menghapus rule existing stop-loss/take-profit/OOR/low-yield/trailing.

PRIORITAS 2 - DYNAMIC STOP-LOSS ATR-BASED (NON-BREAKING)

Target implementasi:
- Tambahkan indikator ATR:
  - tools/indicators/atr.js
- Tambahkan modul risk helper:
  - tools/risk/dynamic-stop-loss.js

Integrasi:
- Hitung ATR dari OHLCV timeframe pendek saat evaluasi management.
- Hitung dynamic stop threshold dan clamp dengan batas config.
- Rule final close tetap mempertahankan stop-loss static existing sebagai fallback.

Config tambahan:
- riskManagement.stopLossATRMultiplier
- riskManagement.atrPeriod
- riskManagement.minStopLossPct
- riskManagement.maxStopLossPct

PRIORITAS 3 - ON-CHAIN INTELLIGENCE (EXTEND GMGN)

Target implementasi:
- Perluas tools/gmgn.js dengan method additive untuk:
  - holder concentration tambahan (top50 jika endpoint tersedia)
  - dev holdings (jika endpoint tersedia)
  - smart money flow net buy/sell (jika endpoint tersedia)
- Jika endpoint tertentu belum tervalidasi, isi TODO + fallback behavior aman.

Integrasi:
- Screening:
  - Tambah penolakan kandidat jika metrik risiko melampaui threshold baru (saat enabled).
  - Tambah bonus score jika smart money net buy valid dan di atas threshold.
- Management:
  - Tambahkan signal exit tambahan jika net sell ekstrem atau whale-dump trigger terdeteksi.

Config tambahan:
- onChainIntelligence.enabled
- onChainIntelligence.smartMoney.*
- onChainIntelligence.holderConcentration.*
- onChainIntelligence.devWallet.*

PRIORITAS 4 - CIRCUIT BREAKER & RETRY TERPUSAT

Target implementasi:
- Tambahkan util reusable:
  - utils/resilience/circuit-breaker.js
  - utils/resilience/with-retry.js

Integrasi minimal:
- tools/screening.js (network calls)
- tools/token.js
- tools/gmgn.js
- tools/agent-meridian.js
- bagian call provider di agent.js (tanpa mengubah kontrak utama agent loop)

Tujuan:
- Bukan mengganti retry existing seluruhnya secara agresif, tetapi menambahkan lapisan terpadu secara bertahap dan backward-compatible.

PRIORITAS 5 - KONFIRMASI TRANSAKSI FINALIZED + PRIORITY FEE STRATEGY

Target implementasi:
- Tambahkan util:
  - tools/execution/confirmation.js
  - tools/execution/priority-fee.js

Integrasi:
- Dipakai pada jalur deploy/claim/close di tools/dlmm.js secara bertahap.
- Tetap pertahankan behavior existing sebagai fallback saat kondisi tertentu.

Tujuan:
- Status transaksi lebih kuat (finalized-aware) tanpa merusak flow existing.

FORMAT OUTPUT WAJIB PER PRIORITAS
1) Pendekatan implementasi
2) Patch file yang dibuat/diubah
3) Alasan teknis dan kompatibilitas
4) Tambahan config user-config
5) Catatan test

---

# Matriks Implementasi (File Aktual Repo)

Prioritas 1 (TA):
- Tambah: tools/indicators/rsi.js
- Tambah: tools/indicators/macd.js
- Tambah: tools/indicators/support-resistance.js
- Tambah: tools/ohlcv.js
- Ubah: tools/screening.js
- Ubah: index.js atau state.js (signal exit additive)
- Ubah: config.js, tools/executor.js, user-config.example.json

Prioritas 2 (ATR SL):
- Tambah: tools/indicators/atr.js
- Tambah: tools/risk/dynamic-stop-loss.js
- Ubah: index.js/state.js (close rule extension)
- Ubah: config.js, tools/executor.js, user-config.example.json

Prioritas 3 (On-chain intel):
- Ubah: tools/gmgn.js
- Ubah: tools/token.js
- Ubah: tools/screening.js
- Ubah: index.js/state.js
- Ubah: config.js, tools/executor.js, user-config.example.json

Prioritas 4 (Resilience):
- Tambah: utils/resilience/circuit-breaker.js
- Tambah: utils/resilience/with-retry.js
- Ubah bertahap: tools/agent-meridian.js, tools/gmgn.js, tools/screening.js, tools/token.js, agent.js

Prioritas 5 (Tx confirmation):
- Tambah: tools/execution/confirmation.js
- Tambah: tools/execution/priority-fee.js
- Ubah: tools/dlmm.js

Guard utama pengembangan:
- No function removal.
- No destructive behavior change.
- Additive, testable, rollback-friendly.