# dsh-keyless-search

[English](README.md) | **Bahasa Indonesia**

**Web search untuk DeepSeek Harness yang berjalan tanpa API key.**

Bundle DSH yang mendaftarkan backend `web_search` pada seam `ctx.web`. Beberapa
backend publik yang independen dirangkai berurutan dan yang pertama menjawab
dipakai, sehingga satu endpoint yang mati atau kena rate limit tidak mematikan
fitur pencarian. Tanpa daftar akun, tanpa key, tanpa kartu kredit.

Berjalan di **Windows, macOS, dan Linux**.

---

## Kenapa tidak butuh API key

Setiap backend adalah endpoint publik yang menjawab request tanpa autentikasi —
tidak ada kredensial yang dibaca, disimpan, atau dikirim.

| Backend | Endpoint | Transport | Peran |
|---|---|---|---|
| WebCrawler | `webcrawler.com/search/web` | HTML | umum |
| Mwmbl | `api.mwmbl.org/search` | JSON | umum |
| Lumy | `search.lumy.live/search?format=json` | JSON (SearXNG) | umum |
| Wikipedia | `en.wikipedia.org/w/api.php` | JSON | khusus |
| Hacker News | `hn.algolia.com/api/v1/search` | JSON | khusus |
| TinyFish | `agent.tinyfish.ai/mcp` | MCP JSON-RPC | umum (tier tamu) |
| Exa | `mcp.exa.ai/mcp` | MCP JSON-RPC | umum |
| Parallel | `mcp.parallel.ai/mcp` | MCP JSON-RPC | umum |

Backend opsional, tidak ada di rantai default — tambahkan sendiri ke `backends`:

| Backend | Endpoint | Transport | Paling cocok untuk |
|---|---|---|---|
| MDN | `developer.mozilla.org/api/v1/search` | JSON | API web / browser |
| npm | `registry.npmjs.org/-/v1/search` | JSON | package |
| arXiv | `export.arxiv.org/api/query` | Atom XML | makalah |
| Google News | `news.google.com/rss/search` | RSS | berita terbaru |

> Semuanya layanan publik pihak ketiga. Batas kuota dan ketersediaannya bisa
> berubah tanpa pemberitahuan — itulah alasan plugin ini membawa rantai backend,
> bukan satu backend tunggal, dan menangani kegagalan dengan rapi.

**TinyFish** adalah satu-satunya backend dengan kuota keras, bukan sekadar rate
limit: tier tamu anonimnya memberi **50 pencarian/hari per jaringan** (dipakai
bersama oleh semua mesin di balik IP yang sama) plus 30 request/menit. Karena itu
posisinya di belakang — backend sebelumnya tidak butuh kuota sama sekali. Akun
TinyFish gratis menaikkan batas ke 12.000/hari, tapi itu butuh key dan di luar
cakupan bundle ini.

---

## Instalasi

```bash
dsh plugin --profile <nama-profil> add dsh-keyless-search
```

Ganti `<nama-profil>` dengan nama profil Anda (`web`, `tui`, `superagent`, …).

Perintah itu mendaftarkan paket sebagai bundle di `package.json` profil Anda dan
menerapkan patch-nya. Restart DSH setelahnya.

### Instalasi dari checkout lokal

```bash
dsh plugin --profile <nama-profil> add /path/absolut/ke/dsh-keyless-search
```

Di Windows gunakan path penuh seperti `C:\src\dsh-keyless-search`.

### Verifikasi

```bash
dsh --profile <nama-profil> --dump-config | grep -E "keyless|searchProvider"
```

Di Windows, gunakan `Select-String` sebagai pengganti `grep`:

```powershell
dsh --profile <nama-profil> --dump-config | Select-String "keyless|searchProvider"
```

Anda semestinya melihat entri `keyless-search` dan `searchProvider: keyless-mcp`
yang mem-patch baris `web`. Setelah itu minta agent mencari informasi terkini,
atau panggil tool `web_search` langsung.

---

## Cara kerja

Plugin mendaftarkan provider bernama `keyless-mcp` pada seam `ctx.web`. Saat model
memanggil `web_search`:

1. Backend dicoba sesuai urutan konfigurasi — mesin umum dulu, lalu backend
   khusus yang bebas kuota.
2. Backend pertama yang mengembalikan sumber dipakai.
3. Backend yang gagal dilewati, dicatat sebagai warning, lalu dikenai
   **cooldown**.
4. Kalau semua backend gagal, `WEB_PROVIDER_ERROR` dilempar beserta alasan
   masing-masing backend.

Setiap backend dipanggil **stateless** — satu pencarian adalah satu request HTTP,
tanpa handshake `initialize` dan tanpa session id.

### Cooldown

Backend yang gagal tidak dicoba ulang pada setiap pencarian berikutnya.
Kegagalan pertama memarkirnya 60 detik, dan setiap kegagalan berurutan
menggandakan jendela itu sampai maksimal 15 menit. Backend yang kembali menjawab
langsung dilepas dari cooldown.

Kalau server menyebutkan sendiri berapa lama harus menunggu, angka itulah yang
dipakai — entah lewat header HTTP `Retry-After`, entah lewat waktu reset yang
tertanam di pesan kuota. Tier tamu TinyFish melaporkan waktu habisnya kuota
harian dengan cara ini, jadi ia diam sampai reset yang sebenarnya alih-alih
dicoba ulang setiap 15 menit.

Ini penting karena endpoint publik gagal secara bergelombang: tanpa cooldown,
satu mesin yang diblokir akan menambahkan timeout-nya ke *setiap* pencarian.

---

## Konfigurasi

Default sudah tertanam dan langsung berfungsi. Untuk mengubah, edit blok `config`
pada `cordis.patch.yml` yang terpasang, atau salin patch bundle ini ke patch
profil Anda.

| Field | Default | Arti |
|---|---|---|
| `backends` | `[webcrawler, mwmbl, lumy, wikipedia, hackernews, tinyfish, exa, parallel]` | Urutan backend; yang pertama menjawab menang |
| `timeoutMs` | `20000` | Timeout per pencarian untuk satu backend, milidetik |
| `maxResults` | `10` | Batas atas sumber yang diminta per backend |

Seam tetap menegakkan `maxResults` milik pemanggil, jadi nilai yang lebih kecil
dari `dsh-tool-web` selalu menang.

Contoh — hanya backend khusus yang selalu tersedia, timeout lebih panjang:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - wikipedia
          - hackernews
        timeoutMs: 60000
```

Contoh — menambahkan sumber spesifik topik ke rantai:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - webcrawler
          - mwmbl
          - mdn
          - npm
          - arxiv
```

Nama backend yang tidak dikenal dibuang dengan warning; kalau daftar hasilnya
kosong, rantai default dipakai.

---

## Catatan lintas sistem operasi

Plugin ini sengaja tanpa dependency dan tanpa path supaya berperilaku identik di
setiap OS:

- **Tanpa import.** `lib/index.js` tidak mengimpor apa pun, sehingga bisa
  di-resolve dari direktori profil mana pun tanpa langkah instalasi atau
  dependency tree yang cocok.
- **Tanpa pengolahan path.** Tidak ada `node:path`, tidak ada separator, tidak ada
  shell — tidak ada yang berbeda antara Windows dan POSIX.
- **Hanya global standar web.** `fetch`, `AbortSignal`, `URL`, `TextDecoder`, dan
  `AbortController`, semuanya disediakan Node sendiri.
- **Deteksi fitur.** `AbortSignal.any` dan `AbortSignal.timeout` dipakai kalau ada
  dan digantikan controller manual dengan timer kalau tidak, sehingga build Node
  lama tetap jalan.
- **Tanpa modul native.** Tidak ada yang perlu dikompilasi, jadi tidak butuh build
  tools di Windows.

Diuji di Linux dengan Node 24. Instalasi lewat `dsh plugin add`, yang mengikuti
jalur perintah yang sama di Windows dan macOS, tanpa langkah khusus platform.

---

## Pengembangan

```bash
npm test          # test parser + provider, tanpa jaringan
npm run test:live # smoke test opt-in ke backend publik yang sebenarnya
```

`npm test` bersifat hermetis: ia mengalirkan bentuk respons yang direkam ke
setiap parser dan menguji rangkaian backend, cooldown, serta pembatalan dengan
backend palsu.

---

## Menghapus

```bash
dsh plugin --profile <nama-profil> remove dsh-keyless-search
```

Setelah itu search kembali ke provider yang dipilih profil Anda sebelumnya
(`deepseek-official` secara default, yang memerlukan `DEEPSEEK_API_KEY`).

---

## Pemecahan masalah

**`WEB_PROVIDER_AMBIGUOUS` pada fetch.** Blok `config` baris `web` digantikan oleh
patch bundle ini. Kalau Anda menimpa baris itu sendiri, `fetchProvider: http`
wajib ditulis ulang; kalau tidak, dua fetch provider tetap terdaftar
(`deepseek-fetch-api` dan `http`) dan seam menolak memilih.

**`WEB_PROVIDER_AMBIGUOUS` pada search.** Ada provider search lain yang terdaftar
sementara `searchProvider` tidak diset. Bundle ini memaku
`searchProvider: keyless-mcp`, jadi ini hanya terjadi kalau baris itu Anda hapus.

**Semua backend gagal.** Periksa akses jaringan ke host pada tabel di atas. Proxy
korporat dan firewall adalah penyebab yang paling umum. Error yang dilempar
menyebut alasan tiap backend, jadi mulai dari situ.

**Tidak ada hasil tapi tidak ada error.** Hasil parsial tetap dikembalikan selama
ada satu backend yang menjawab. Plugin hanya melempar error bila semua backend
mengembalikan kosong atau gagal.

**Pencarian tiba-tiba lebih lambat.** Kemungkinan ada backend yang mulai gagal dan
sedang dicoba ulang melalui cooldown pertamanya. Baris warning terstruktur
(`keyless_search_backend_failed`) menyebutkan backend mana.

**Satu backend terus dilewati.** Cooldown-nya bisa membesar sampai beberapa menit
setelah gagal berulang kali. Restart DSH menghapus cooldown tersebut.

---

## Lisensi

MIT — lihat [LICENSE](LICENSE).
