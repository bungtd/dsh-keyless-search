# dsh-keyless-search

[English](README.md) | **Bahasa Indonesia**

**Web search untuk DeepSeek Harness yang berjalan tanpa API key.**

Bundle DSH yang mendaftarkan backend `web_search` pada seam `ctx.web` memakai
layanan MCP hosted yang menerima request tanpa autentikasi — pendekatan yang sama
dipakai OpenCode CLI untuk tool `websearch`-nya. Tanpa daftar akun, tanpa key,
tanpa kartu kredit.

Berjalan di **Windows, macOS, dan Linux**.

---

## Kenapa tidak butuh API key

Kedua backend adalah endpoint MCP publik yang menjawab `tools/call` tanpa
autentikasi:

| Backend | Endpoint | Tool | Peran |
|---|---|---|---|
| Exa | `https://mcp.exa.ai/mcp` | `web_search_exa` | utama |
| Parallel | `https://mcp.parallel.ai/mcp` | `web_search` | cadangan |

Tidak ada kredensial yang dibaca, disimpan, atau dikirim. Plugin memanggil
endpoint langsung lalu mem-parse sumber yang dikembalikan.

> Keduanya layanan publik pihak ketiga. Batas kuota dan ketersediaannya bisa
> berubah tanpa pemberitahuan — itulah alasan plugin ini membawa rantai cadangan,
> bukan satu backend tunggal.

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

1. Backend dicoba berurutan — **Exa** dulu, lalu **Parallel**.
2. Backend pertama yang mengembalikan sumber dipakai.
3. Backend yang gagal atau kosong dilewati dan dicatat sebagai warning.
4. Kalau semua backend gagal, `WEB_PROVIDER_ERROR` dilempar beserta alasan
   masing-masing backend.

Kedua backend dipanggil **stateless** — tanpa handshake `initialize` dan tanpa
session id — sehingga satu pencarian adalah satu request HTTP.

---

## Konfigurasi

Default sudah tertanam dan langsung berfungsi. Untuk mengubah, edit blok `config`
pada `cordis.patch.yml` yang terpasang, atau salin patch bundle ini ke patch
profil Anda.

| Field | Default | Arti |
|---|---|---|
| `backends` | `[exa, parallel]` | Urutan backend; yang pertama menjawab menang |
| `timeoutMs` | `45000` | Timeout per pencarian untuk satu backend, milidetik |
| `maxResults` | `10` | Batas atas sumber yang diminta per backend |

Seam tetap menegakkan `maxResults` milik pemanggil, jadi nilai yang lebih kecil
dari `dsh-tool-web` selalu menang.

Contoh — hanya Parallel, timeout lebih panjang:

```yaml
- insert:
    - id: keyless-search
      name: 'dsh-keyless-search'
      config:
        backends:
          - parallel
        timeoutMs: 60000
```

---

## Catatan lintas sistem operasi

Plugin ini sengaja tanpa dependency dan tanpa path supaya berperilaku identik di
semua OS:

- **Tanpa import.** `lib/index.js` tidak mengimpor apa pun, sehingga ter-resolve
  dari direktori profil mana pun tanpa langkah install atau kecocokan dependency.
- **Tanpa penanganan path.** Tidak ada `node:path`, tidak ada separator, tidak ada
  shell — tidak ada yang berbeda antara Windows dan POSIX.
- **Hanya global standar web.** `fetch`, `AbortSignal`, `URL`, `TextDecoder`, dan
  `AbortController`, semuanya disediakan Node sendiri.
- **Feature detection.** `AbortSignal.any` dan `AbortSignal.timeout` dipakai bila
  tersedia, dan diganti controller manual dengan timer bila tidak — jadi Node
  versi lama tetap jalan.
- **Tanpa native module.** Tidak ada yang perlu dikompilasi, jadi tidak butuh
  build tools di Windows.

Diuji di Linux dengan Node 24. Instalasi lewat `dsh plugin add`, jalur perintah
yang sama di Windows dan macOS, tanpa langkah khusus platform.

---

## Mencopot

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

**Semua backend gagal.** Periksa akses jaringan ke `mcp.exa.ai` dan
`mcp.parallel.ai`. Proxy korporat dan firewall adalah penyebab yang paling umum.

**Tidak ada hasil tapi tidak ada error.** Hasil parsial tetap dikembalikan selama
ada satu backend yang menjawab. Plugin hanya melempar error bila semua backend
mengembalikan kosong atau gagal.

---

## Lisensi

MIT — lihat [LICENSE](LICENSE).
