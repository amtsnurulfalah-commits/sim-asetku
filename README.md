# Sistem Informasi Inventaris Madrasah/Sekolah

Panduan setup dan penggunaan aplikasi inventaris multi-tenant untuk madrasah dan sekolah.

**Versi sumber acuan: 0.14.2.** Letakkan `README.md` ini di root aplikasi, sejajar dengan `package.json` dan `vercel.json`. Semua perintah dijalankan dari folder tersebut, kecuali dinyatakan lain. Tautan dokumentasi relatif mengacu pada berkas dalam paket sumber aplikasi.

> **Status implementasi:** pengujian lokal telah dilakukan, tetapi penerimaan produksi belum selesai. Perbaikan build 0.14.2 telah lulus build lokal; redeploy Vercel dan integrasi Central SSO, Supabase, serta Google Drive nyata masih perlu diverifikasi pada lingkungan tujuan. Tidak ada akun atau password bawaan untuk masuk ke aplikasi.

## Daftar isi

- [Tentang aplikasi](#tentang-aplikasi)
- [Fitur utama](#fitur-utama)
- [Arsitektur dan teknologi](#arsitektur-dan-teknologi)
- [Peran dan hak akses](#peran-dan-hak-akses)
- [Persyaratan](#persyaratan)
- [Urutan setup](#urutan-setup)
- [Instalasi sumber aplikasi](#instalasi-sumber-aplikasi)
- [Setup database](#setup-database)
- [Setup Central SSO](#setup-central-sso)
- [Setup Google Drive](#setup-google-drive)
- [Konfigurasi environment](#konfigurasi-environment)
- [Menjalankan aplikasi lokal](#menjalankan-aplikasi-lokal)
- [Menyiapkan operator pertama](#menyiapkan-operator-pertama)
- [Onboarding lembaga](#onboarding-lembaga)
- [Deployment Vercel](#deployment-vercel)
- [Panduan penggunaan](#panduan-penggunaan)
- [Pengujian dan pemeriksaan](#pengujian-dan-pemeriksaan)
- [Operasional dan pemeliharaan](#operasional-dan-pemeliharaan)
- [Troubleshooting](#troubleshooting)
- [Struktur proyek](#struktur-proyek)
- [Dokumentasi lanjutan](#dokumentasi-lanjutan)
- [Batas verifikasi](#batas-verifikasi)

## Tentang aplikasi

Aplikasi membantu lembaga mencatat, memantau, memindahkan, meminjamkan, memelihara, menyusutkan, dan melaporkan aset serta persediaan. Satu instalasi melayani beberapa madrasah/sekolah, dengan data dan izin terikat pada lembaga atau **tenant** yang aktif.

Identitas pengguna berasal dari Central SSO. Aplikasi inventaris mengelola izin lokal berdasarkan `sso_user_id`, membership lembaga, role, dan permissions. Pengguna yang berhasil diautentikasi di pusat belum otomatis memperoleh akses inventaris; ia tetap memerlukan akses lokal atau grant operator yang sesuai.

## Fitur utama

| Kelompok | Fitur |
|---|---|
| Akses dan lembaga | Login Central SSO, sesi lokal, pilihan lembaga, provisioning dan status tenant |
| Administrasi | Profil lembaga, pengguna dari direktori pusat, role dan matrix permissions |
| Master data | Kategori/subkategori, satuan, kondisi, sumber dana, gedung, ruangan dan kebijakan |
| Register aset | Aset tetap serta detail tanah, bangunan, kendaraan dan jenis aset lainnya |
| QR dan label | QR aset, pemindaian kamera/input manual, cetak label |
| Persediaan | Barang, saldo, kartu stok, pengeluaran dan penyesuaian |
| Pengadaan | Kebutuhan, pesanan, penerimaan dan pemeriksaan barang |
| Transaksi aset | Penempatan, mutasi, peminjaman/pengembalian, pemeliharaan, stock opname dan penghapusan |
| Approval | Workflow berversi, persetujuan bertingkat, revisi, pembatalan dan delegasi |
| Penyusutan | Pratinjau periodik, posting, ledger, valuasi dan koreksi |
| Dokumen | Upload bertahap, recovery, download privat, arsip dan rekonsiliasi Drive |
| Laporan | Dashboard, daftar aset, KIB, KIR, stok, transaksi, penyusutan, berita acara, PDF dan XLSX |
| Riwayat | Jejak administratif, perubahan bisnis dan event ekspor |

Ketersediaan menu dan tindakan mengikuti permissions, status lembaga, serta status dokumen. Format laporan perlu ditinjau instansi sebelum dipakai sebagai dokumen resmi.

## Arsitektur dan teknologi

| Komponen | Fungsi |
|---|---|
| Next.js 16.4.2, React 19.3.1, TypeScript | Halaman aplikasi, API server, sesi dan proses bisnis |
| Tailwind CSS dan komponen UI | Antarmuka pengguna |
| Central SSO berbasis GAS/Spreadsheet melalui gateway HTTPS | Pusat identitas dan validasi username/password |
| Supabase PostgreSQL | Data bisnis, user lokal, role, permissions, metadata file, audit dan RLS |
| Google Drive | Penyimpanan bytes foto dan dokumen privat |
| Vercel | Hosting Next.js |
| GitHub Actions | Verifikasi sumber ketika repository dihubungkan |

**Supabase Auth tidak digunakan. Supabase Storage tidak digunakan.** Password pusat tidak disimpan pada database inventaris. Browser mengakses API aplikasi; koneksi database dan credential integrasi berada di server.

Sumber saat ini memuat 13 migrasi dan 96 tabel pada schema `inventory`. RLS dan constraint melengkapi pemeriksaan sesi, tenant, permission, serta aturan bisnis pada backend.

## Peran dan hak akses

| Peran | Tanggung jawab |
|---|---|
| Operator platform | Membuat/mengaktifkan/menonaktifkan lembaga melalui grant operator terbatas waktu |
| Admin lembaga | Mengelola profil, keanggotaan, izin yang dapat diubah, Drive dan konfigurasi lembaga sendiri |
| Petugas | Menjalankan pencatatan dan transaksi sesuai permissions lokal |
| Viewer | Membaca informasi sesuai permissions lokal |

Operator bukan role bisnis keempat yang otomatis dapat membaca inventaris seluruh lembaga. Ia memerlukan membership eksplisit bila juga ditugaskan sebagai pengguna bisnis. Satu pengguna dapat memiliki role berbeda pada lembaga yang berbeda. Approver ditentukan oleh workflow dan izin yang berlaku.

## Persyaratan

- Node.js **24.x** dan npm.
- Paket sumber aplikasi, termasuk `package-lock.json`, `assets/fonts`, dan seluruh migrasi.
- Project Supabase PostgreSQL untuk lingkungan uji; pisahkan dari produksi.
- Gateway HTTPS Central SSO, aplikasi/key terdaftar, dan akun pusat aktif.
- Google Cloud project dengan Drive API serta OAuth client atau service account Shared Drive sesuai pilihan integrasi.
- Python 3 dan dependensi `requirements-test.txt` untuk runner migrasi/pemeriksaan dokumentasi tertentu.
- `psql` atau klien PostgreSQL administratif untuk provisioning login database.
- Untuk hosting: project Vercel, domain/origin HTTPS yang ditentukan, dan repository GitHub bila memakai integrasi Git.

Tes aplikasi lokal memakai PGlite dan provider tiruan. PGlite adalah lingkungan pengujian, bukan pengganti database runtime aplikasi.

## Urutan setup

1. Ekstrak/ambil sumber, pasang dependensi, dan siapkan environment lokal.
2. Siapkan database uji, jalankan migrasi, lalu buat dua login runtime non-owner.
3. Daftarkan integrasi aplikasi pada Central SSO.
4. Siapkan OAuth/Shared Drive dan kunci enkripsi Drive.
5. Jalankan aplikasi dan periksa konfigurasi.
6. Bootstrap operator pertama dengan akun pusat yang sudah ada.
7. Buat lembaga, tentukan admin, siapkan Drive, lalu aktifkan lembaga.
8. Isi master, pengguna, kebijakan dan data uji; lakukan verifikasi alur bisnis.
9. Deploy dari sumber terbaru dan selesaikan pemeriksaan target sebelum penerimaan produksi.

## Instalasi sumber aplikasi

Ekstrak paket dan masuk ke folder yang berisi `package.json`. Jangan menjalankan npm dari folder luar yang hanya berisi ZIP atau satu folder pembungkus.

```bash
node --version
npm --version
npm ci --ignore-scripts
```

Buat `.env.local` dari template:

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env.local
```

**Linux/macOS:**

```bash
cp .env.example .env.local
```

Isi melalui editor lokal yang aman. Placeholder pada panduan bukan nilai siap pakai. Jangan commit file `.env.local`, token, private key, atau dump data lembaga.

## Setup database

### Menyiapkan target

Gunakan project Supabase uji yang jelas identitasnya. Siapkan koneksi administratif terpisah dari koneksi aplikasi. Jangan menggunakan akun pemilik tabel sebagai `DATABASE_URL` atau `AUTH_DATABASE_URL` runtime.

Aplikasi menggunakan schema `inventory` dan `inventory_security` melalui driver PostgreSQL server. Tidak perlu membuat pengguna Supabase Auth atau bucket Storage untuk aplikasi ini. Jangan mengekspos schema aplikasi melalui Data API tanpa desain otorisasi tambahan.

Jika target sudah berisi instalasi/data, cadangkan dan cocokkan riwayat migrasi sebelum melanjutkan. Jangan menjalankan `tests/fixtures.sql` pada staging atau produksi.

### Memasang driver migrasi

Gunakan virtual environment Python bila memungkinkan. Contoh membuatnya:

```bash
python -m venv .venv
```

Aktifkan sesuai sistem:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
# Linux/macOS
source .venv/bin/activate
```

Pada sistem yang memakai nama `python3`, sesuaikan perintah `python` di panduan ini. Kemudian:

```bash
python -m pip install -r requirements-test.txt
```

### Menjalankan migrasi

Runner hanya menerima **`MIGRATION_DATABASE_URL` eksplisit**. Ia tidak mengambil `DATABASE_URL` sebagai fallback. Python tidak otomatis membaca `.env.local`.

Contoh berikut meminta URL secara tersembunyi di terminal, menggunakannya hanya dalam proses Python, lalu menjalankan runner:

```bash
python -c "import getpass,os,runpy; os.environ['MIGRATION_DATABASE_URL']=getpass.getpass('URL database migrasi: '); runpy.run_path('scripts/apply_migrations.py',run_name='__main__')"
```

Masukkan URL administratif untuk target yang telah dipastikan, dengan konfigurasi TLS dan CA sesuai penyedia. Jika password URL mengandung karakter khusus, lakukan URL-encoding pada komponen password tersebut.

Runner menerapkan file SQL berurutan, menggunakan advisory lock dan mencatat checksum pada `inventory_migrations.history`. Migrasi yang checksum-nya cocok dilewati. Ketidakcocokan checksum harus diselidiki, bukan ditutupi dengan mengubah history. Instalasi yang dahulu dijalankan manual perlu rekonsiliasi riwayat sebelum memakai runner ini.

### Membuat dua login runtime

Setelah migrasi berhasil, buka [skrip provisioning](deployment/runtime-logins.sql) pada sesi administratif PostgreSQL yang terhubung ke target benar. Skrip membuat:

| Login | Membership group | Dipakai oleh |
|---|---|---|
| `inventory_web_auth` | `inventory_auth` | `AUTH_DATABASE_URL` |
| `inventory_web_runtime` | `inventory_runtime` | `DATABASE_URL` |

Skrip mengasumsikan nama database `postgres`; sesuaikan jika berbeda. Bila nama role sudah ada, berhenti dan periksa atribut/membership yang ada sebelum mengulang.

Skrip belum mengisi password. Pada sesi `psql` interaktif, tetapkan password berbeda dengan:

```text
\password inventory_web_auth
\password inventory_web_runtime
```

Gunakan login non-owner dengan hak minimal. Koneksi runtime tidak boleh berhak superuser, bypass RLS, membuat role/database, atau menjadi member pemilik tabel. Lihat [panduan database](docs/tahap-14/02-Database.md).

### Memilih koneksi

Gunakan direct connection atau session pooler yang benar-benar mendukung login kustom dan `SET LOCAL ROLE`. Jangan menganggap transaction pooler kompatibel; validator saat ini menolak port `6543`. Periksa kemampuan IPv4/IPv6 host dan region deployment.

Koneksi remote memakai `DATABASE_TLS_MODE=verify-full`. Isi `DATABASE_CA_CERT` bila CA khusus diperlukan. Menonaktifkan TLS hanya didukung untuk database localhost saat development.

File `compose.yaml` tersedia sebagai opsi database **uji lokal** dan menggunakan PostgreSQL 16 pada port loopback 55432. Compose tersebut tidak mengonfigurasi volume persisten; jangan dipakai sebagai penyimpanan operasional. Provisioning nama database/role harus disesuaikan. Konkurensi dan kompatibilitas PostgreSQL native pada target masih perlu diuji.

## Setup Central SSO

Siapkan integrasi pada pengelola Central SSO:

1. Tentukan aplikasi inventaris yang akan memakai identitas pusat.
2. Daftarkan application ID dan key ID yang berlaku.
3. Dapatkan client secret sesuai kontrak pusat: 64 karakter hex huruf kecil.
4. Tentukan origin gateway HTTPS tanpa path atau slash akhir. Nilainya bukan URL deployment GAS langsung.
5. Pastikan operasi verifikasi login, status user, pencarian dan detail direktori tersedia.

| Path gateway | Operasi |
|---|---|
| `/api/v1/auth/verify` | `authenticate.user` |
| `/api/v1/users/status` | `user.status` |
| `/api/v1/directory/search` | `directory.search` |
| `/api/v1/directory/get` | `directory.get` |

Client aplikasi sudah membentuk envelope HMAC server-to-server. Jangan membuat signature di browser atau menulis envelope login ke log: payload base64url bukan enkripsi password.

Akun pengguna dibuat/dikelola pada pusat identitas. Aplikasi inventaris tidak menyediakan username/password default dan tidak membuat password melalui bootstrap operator. Integrasi lengkap dijelaskan pada [panduan Central SSO](docs/tahap-14/04-Central-SSO.md).

## Setup Google Drive

### Memilih mode

| Pilihan | Konfigurasi |
|---|---|
| My Drive dengan OAuth | OAuth Web Application, client ID/secret, consent/audience dan redirect URI |
| Shared Drive dengan service account | Credential service account server dan akses pada Shared Drive yang dituju |

Service account tidak digunakan untuk upload ke kuota pribadi My Drive. Mode OAuth juga perlu izin akun yang tepat terhadap folder tujuan.

### Menyiapkan Google Cloud dan kunci

1. Aktifkan Google Drive API pada project organisasi.
2. Untuk OAuth, daftarkan redirect URI persis `APP_BASE_URL/api/drive/oauth/callback`; misalnya origin staging memakai callback staging. Konfigurasikan akun uji/audience dan persyaratan publikasi/verifikasi yang sesuai.
3. Implementasi memakai scope `https://www.googleapis.com/auth/drive` karena admin dapat memasukkan folder yang sudah ada. Jangan mengganti scope saja tanpa menyesuaikan desain akses objek.
4. Untuk service account, berikan akses Shared Drive yang diperlukan untuk membaca metadata/list, membuat file/folder, mengunggah dan men-trash objek uji.
5. Siapkan ring kunci AES-256 untuk mengenkripsi token dan URL resumable di server.

Untuk membuat nilai acak pada terminal lokal tepercaya, jalankan dua perintah ini **secara terpisah**:

```bash
# Nilai RATE_LIMIT_SECRET; jangan dipakai ulang sebagai secret integrasi lain.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

# Satu nilai kunci AES-256 base64 untuk ring Drive.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Contoh bentuk ring kunci di `.env.local`:

```dotenv
DRIVE_ACTIVE_KEY_ID=k202610
DRIVE_ENCRYPTION_KEYS='{"k202610":"GANTI_DENGAN_BASE64_32_BYTE_HASIL_GENERATOR"}'
```

Ganti placeholder dengan hasil generator yang sebenarnya. Simpan key ring agar dapat dipulihkan; kehilangan key dapat membuat token koneksi terenkripsi tidak terbaca.

### Menghubungkan folder

Setelah admin lembaga tersedia, buka `/administrasi/drive`, masukkan URL/ID root folder yang unik bagi lembaga, lalu lakukan otorisasi atau uji Shared Drive sesuai mode.

Test Koneksi memanggil Google: membaca metadata/list, membuat folder uji, mengunggah satu byte, kemudian men-trash objek uji. Kegagalan cleanup tidak dianggap sukses. Setelah siap, inisialisasi subfolder. Root tenant tidak boleh sama, saling bertumpang tindih, atau berupa shortcut.

File bisnis tetap privat. Mengetahui QR atau ID file tidak menggantikan sesi dan izin aplikasi. Lihat [panduan Google Drive](docs/tahap-14/05-Google-Drive.md).

## Konfigurasi environment

Gunakan `.env.example` sebagai daftar kunci aktual. Nilai sensitif disimpan pada environment server. Tidak ada kebutuhan memasukkan secret ke variabel berawalan `NEXT_PUBLIC_`.

| Variabel | Ketentuan |
|---|---|
| `APP_BASE_URL` | Origin aplikasi tanpa slash akhir; development localhost boleh HTTP, produksi wajib HTTPS |
| `CENTRAL_SSO_API_URL` | Origin gateway HTTPS Central SSO |
| `CENTRAL_SSO_APPLICATION_ID` | Application ID yang terdaftar di pusat |
| `CENTRAL_SSO_KEY_ID` | Key ID aktif milik aplikasi |
| `CENTRAL_SSO_CLIENT_SECRET` | Client secret pusat, 64 hex huruf kecil |
| `CENTRAL_SSO_TIMEOUT_MS` | Opsional, 1000–60000 ms; template memakai 45000 |
| `AUTH_DATABASE_URL` | Login auth non-owner, member group `inventory_auth` |
| `DATABASE_URL` | Login bisnis non-owner yang berbeda, member group `inventory_runtime` |
| `DATABASE_TLS_MODE` | `verify-full` untuk remote/produksi; `disable` hanya localhost development |
| `DATABASE_CA_CERT` | Opsional, CA PEM sesuai koneksi TLS |
| `RATE_LIMIT_SECRET` | Acak minimal 32 karakter dan berbeda dari secret SSO |
| `GOOGLE_OAUTH_CLIENT_ID` | Diisi bersama OAuth client secret bila memakai OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret OAuth server |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Alternatif credential service account Shared Drive, JSON lengkap satu baris |
| `DRIVE_ACTIVE_KEY_ID` | ID aktif yang ada di ring kunci |
| `DRIVE_ENCRYPTION_KEYS` | JSON map ID ke kunci 32 byte base64 |
| `DRIVE_MAX_UPLOAD_BYTES` | Default 20971520; batas maksimum implementasi 104857600 |
| `MIGRATION_DATABASE_URL` | **Hanya operator migrasi/bootstrap; jangan dipasang pada runtime Vercel** |

Untuk file environment runtime, hapus atau biarkan kosong entri `MIGRATION_DATABASE_URL` dari template. Simpan nilai administratif pada lingkungan operator terpisah. Seluruh nilai harus sesuai format yang diterapkan kode; menyalin placeholder tidak akan menghasilkan konfigurasi valid.

**Catatan validator:** `deploy:check-env` memeriksa konfigurasi remote/HTTPS lengkap. Mode localhost development dapat ditolak oleh validator tersebut walaupun diizinkan oleh konfigurasi development aplikasi. Validator bukan perintah yang harus dijalankan sebelum setiap `npm run dev`.

## Menjalankan aplikasi lokal

Setelah konfigurasi lokal sesuai:

```bash
npm run dev
```

Buka `http://localhost:3000` dan pastikan sama dengan `APP_BASE_URL`. Menampilkan halaman login belum membuktikan koneksi SSO/database sudah benar.

Untuk menguji build/server produksi lokal:

```bash
npm run build
npm start
```

Build dapat selesai tanpa semua credential runtime karena fitur layanan dinamis. Saat server produksi dijalankan, konfigurasi aplikasi produksi tetap membutuhkan origin HTTPS; siapkan proxy/domain HTTPS jika menguji alur terautentikasi. Jangan mengubah mode TLS agar konfigurasi produksi yang salah tampak lolos.

Script Node standalone tidak otomatis memuat `.env.local`. Contoh pemeriksaan environment target HTTPS:

```bash
node --env-file=.env.local scripts/deploy/check-env.mjs
node --env-file=.env.local scripts/deploy/check-database.mjs
```

Probe database bersifat read-only dan memeriksa TLS, atribut/membership login, schema/RLS serta akses tanpa tenant. Hasilnya bukan pengujian seluruh fitur atau konkurensi native.

## Menyiapkan operator pertama

Lakukan dari mesin administratif setelah migrasi, login database runtime, dan integrasi Central SSO tersedia.

1. Siapkan `.env.local` dengan konfigurasi server/runtime yang benar.
2. Buat file privat `.env.operator.local` yang hanya memuat `MIGRATION_DATABASE_URL` administratif. Jangan masukkan file itu ke Git, unggahan aplikasi, atau runtime Vercel.
3. Tentukan username akun pusat aktif yang memang ditunjuk sebagai operator.
4. Jalankan, dengan mengganti `admin.lembaga` sesuai username pusat yang tepat:

```bash
node --env-file=.env.local --env-file=.env.operator.local --conditions=react-server --import tsx scripts/bootstrap-operator.ts --username=admin.lembaga --days=30
```

Skrip mencari kecocokan akun pusat aktif dan memberi grant operator terbatas waktu; rentang `--days` adalah 1–90. Ia tidak membuat password pusat dan tidak otomatis memberi membership lembaga. Jangan menjalankannya memakai identitas contoh yang belum ada.

Setelah selesai, lindungi akses file/koneksi administratif dan jalankan proses aplikasi biasa tanpa credential migrasi tersebut.

## Onboarding lembaga

1. Operator login dan membuka `/platform/lembaga`.
2. Isi kode unik dan nama lembaga; pilih admin pertama dari direktori Central SSO.
3. Provisioning membuat tenant berstatus `setup`, referensi awal dan membership admin pertama secara atomik.
4. Admin pertama login, melengkapi profil, pengguna/peran, lalu menghubungkan Google Drive.
5. Jalankan Test Koneksi dan inisialisasi subfolder. Tes kesiapan untuk aktivasi harus masih segar, kurang dari 24 jam, dan admin aktif tersedia.
6. Operator mengaktifkan lembaga setelah persyaratan terpenuhi.
7. Admin menyiapkan master, workflow approval, kebijakan penyusutan dan konfigurasi laporan.
8. Jalankan satu siklus data uji lengkap dengan akun pembuat/approver berbeda serta uji isolasi dua tenant sebelum penggunaan operasional.

Tenant `setup` membatasi akses bisnis. Menjadi Admin pada tenant setup tidak otomatis membuka semua transaksi. Status tenant, status akun pusat dan status membership merupakan pemeriksaan yang berbeda.

## Deployment Vercel

### Konfigurasi proyek

Gunakan sumber **versi 0.14.2 atau lebih baru yang sudah ditinjau**, dan root aplikasi yang berisi `package.json` serta `vercel.json`.

| Pengaturan | Nilai acuan |
|---|---|
| Framework | Next.js |
| Node.js | 24.x |
| Install Command | `npm ci --ignore-scripts` |
| Build Command | `npm run build` |
| Output Directory | Ikuti keluaran Next.js, jangan diarahkan ke folder statis buatan |
| Runtime secrets | Atur pada environment target yang sesuai |

`vercel.json` versi 0.14.2 sudah menetapkan build command tersebut. Jangan memakai lagi `npm run deploy:check-env && npm run build` sebagai perintah kompilasi.

### Langkah deployment

1. Pilih team/project dan domain/origin yang benar. Hubungkan repository GitHub bila memakai Git, atau unggah sumber terbaru melalui alur deployment sumber yang digunakan.
2. Pilih region eksekusi yang sesuai dengan lokasi database dan kebutuhan aplikasi.
3. Isi environment Development/Preview/Production secara terpisah. Preview jangan diarahkan ke database/folder produksi secara sembarang.
4. Gunakan origin staging HTTPS yang stabil dan sesuaikan APP_BASE_URL serta callback OAuth. URL preview acak tidak otomatis cocok dengan konfigurasi origin/callback.
5. Deploy sumber terbaru, lalu periksa build log/statusnya.
6. Jalankan pemeriksaan konfigurasi target secara terpisah dan uji login, tenant, Drive, approval/posting serta ekspor. Build `READY` tidak menggantikan penerimaan fungsional.

Jika deployment memakai **source drop**, tombol redeploy pada sumber lama tetap membawa `vercel.json` lama; unggah sumber terbaru agar perubahan build dipakai. Jika pesan error masih menyebut perintah gabungan lama, periksa versi sumber dan Root Directory.

Project `sim-asetku` sudah teridentifikasi dalam pemeriksaan sebelumnya, tetapi keberhasilan redeploy remote belum diverifikasi. Rincian perbaikan ada pada [catatan build 0.14.2](docs/Perbaikan-Build-Vercel-0.14.2.md).

## Panduan penggunaan

### Masuk, memilih lembaga dan keluar

1. Buka `/login`, masukkan username/password Central SSO.
2. Pilih lembaga yang diizinkan jika aplikasi menampilkan pilihan lembaga.
3. Periksa nama lembaga aktif sebelum membaca atau menyimpan data.
4. Setelah berganti lembaga, muat ulang form/tab lama; permintaan dengan konteks tenant lama akan ditolak.
5. Gunakan tombol Keluar dan konfirmasi saat selesai. Jika sesi berakhir, login ulang.

Masa sesi lokal saat ini maksimal 8 jam dengan idle 30 menit. Perubahan status identitas, membership, role/izin atau tenant dapat mencabut akses lebih cepat.

### Menu utama

| Halaman | Penggunaan |
|---|---|
| `/dashboard` | Memantau ringkasan dan statistik sesuai izin |
| `/master-data` | Menyiapkan kategori, satuan, kondisi, lokasi dan kebijakan |
| `/aset` | Menambah, mencari dan memperbarui register/detail aset |
| `/pindai` | Memindai QR dengan kamera atau memasukkan kode manual |
| `/persediaan` | Memeriksa barang, saldo, kartu stok dan pemakaian |
| `/pengadaan` | Mencatat kebutuhan, pesanan dan penerimaan |
| `/transaksi` | Menjalankan transaksi aset dan melihat status dokumen |
| `/approval` | Memproses antrean persetujuan yang berwenang |
| `/approval/workflow` | Mengelola workflow sesuai izin administratif |
| `/penyusutan` | Menghitung, mengajukan, memposting dan meninjau penyusutan |
| `/laporan` | Memfilter, meninjau dan mengekspor laporan |
| `/dokumen` | Mengelola file yang dapat diakses |
| `/administrasi/pengguna` | Mengatur membership pengguna lembaga |
| `/administrasi/peran` | Mengatur matrix role yang diizinkan |
| `/administrasi/profil` | Melengkapi identitas/profil lembaga |
| `/administrasi/drive` | Menghubungkan dan memelihara koneksi Drive |

### Mencatat aset dan persediaan

Siapkan referensi aktif lebih dahulu. Pada register aset, isi jenis, identitas, tanggal/nilai perolehan, kondisi, lokasi dan detail khusus jenis aset. Tinjau hasil simpan sebelum menautkan dokumen yang sudah `ready`.

Untuk persediaan/pengadaan, catat kebutuhan dan pesanan sesuai alur. Pada penerimaan, bedakan jumlah datang dan jumlah diterima baik beserta hasil pemeriksaan. Pengeluaran stok memerlukan saldo cukup. Jangan mengubah saldo/ledger langsung untuk memperbaiki transaksi; gunakan alur penyesuaian atau koreksi yang didukung.

### Mengajukan dan memposting dokumen

Alur umumnya:

1. Buat dan simpan draft.
2. Tinjau baris, tanggal, lokasi, alasan dan bukti.
3. Ajukan sesuai workflow/kebijakan yang berlaku.
4. Approver memeriksa dan menyetujui, menolak atau meminta revisi sesuai kewenangan.
5. Selesaikan seluruh tingkat persetujuan.
6. Posting dokumen melalui tindakan yang tersedia.

**Approved berbeda dari posted.** Posting masih memeriksa keadaan sumber/aset/stok dan dapat ditolak jika keadaan berubah. Dokumen revisi perlu mengikuti persetujuan yang sah. Jangan melewati workflow dengan mengganti status melalui SQL.

Pada pinjaman, periksa peminjam dan tenggat; pengembalian dapat dilakukan sebagian. Pada opname, catat hasil pemeriksaan sebenarnya; snapshot awal tidak diubah agar terlihat cocok. Penyusutan memerlukan periode valid, policy/umur manfaat dan residu yang tepat; koreksi tidak dilakukan dengan menimpa jurnal lama.

### File dan laporan

- Upload file sampai berstatus `ready` sebelum dipakai sebagai bukti/lampiran.
- Jika terputus, pilih kembali file asli dan gunakan recovery setelah lease yang relevan habis. Jangan memaksa offset atau memakai key operasi lama untuk file berbeda.
- Format upload yang didukung saat ini PDF, JPEG, PNG dan WebP; aplikasi memeriksa MIME, ekstensi, signature, ukuran serta checksum. Chunk maksimal 1 MiB.
- Download file sensitif memerlukan izin tambahan. Arsip aplikasi mempertahankan bytes dan histori; tidak sama dengan menghapus file Google.
- QR tidak memberikan akses publik tanpa sesi/izin. Pemindaian kamera memerlukan HTTPS dan izin kamera browser.
- KIR memerlukan ruangan; berita acara memerlukan dokumen sumber. Pilih periode/filter yang tepat sebelum preview/ekspor.
- Ekspor sinkron dibatasi maksimal 5.000 baris dan batas ukuran/teks lainnya. Persempit filter jika ditolak.
- Ekspor dibuat ulang saat diunduh, sehingga preview lama dapat berbeda jika data berubah. Histori ekspor menyimpan filter/checksum; file hasil ekspor tidak otomatis disimpan ke Drive.

## Pengujian dan pemeriksaan

| Perintah | Cakupan |
|---|---|
| `npm test` | Unit/integrasi aplikasi dengan PGlite dan provider tiruan |
| `npm run test:database` | Migrasi, constraint, hak akses dan RLS pada PGlite |
| `npm run test:deployment` | Validator environment dengan fixture statis |
| `npm run test:migration-target` | Guard target migrasi tanpa koneksi database |
| `npm run typecheck` | Pemeriksaan TypeScript, termasuk variabel/parameter tidak terpakai |
| `npm run lint` | ESLint sumber dan tes yang dikonfigurasi |
| `npm run build` | Kompilasi produksi lokal |
| `npm run test:e2e:smoke` | Sesudah build: halaman anonim dan penolakan saat konfigurasi layanan tidak ada |
| `npm run test:components` | Dua fixture browser komponen laporan dengan API tiruan |
| `npm run audit:deadcode` | Inventaris impor, entry point dan kandidat export; tidak menghapus kode otomatis |
| `npm run docs:check` | Cakupan route, manifest sumber dan tautan dokumentasi yang dikonfigurasi |
| `npm run deploy:check-env` | Kesiapan format environment remote/produksi, dijalankan terpisah |
| `npm run deploy:check-db` | Probe read-only ke database target yang dikonfigurasi |

Script Node standalone membutuhkan environment yang dimuat secara eksplisit. Pemeriksaan dokumentasi dan guard migrasi memakai Python. Browser runner menggunakan Chromium terpaket untuk lingkungan uji; untuk reproduksi yang sama, gunakan lingkungan Linux yang kompatibel. Ini tidak membuktikan dukungan semua perangkat/browser pengguna.

Tes tidak boleh diarahkan ke data produksi. Untuk smoke tanpa konfigurasi, gunakan lingkungan bersih; jangan menganggap tes tersebut menguji login SSO berhasil.

## Operasional dan pemeliharaan

### Backup dan pemulihan

Cadangkan secara terpisah:

1. PostgreSQL, termasuk metadata file, audit, relasi dan riwayat migrasi.
2. Bytes foto/dokumen di Google Drive sesuai kebijakan organisasi.
3. Secret dan ring kunci enkripsi melalui pengelolaan secret yang terkontrol.

Backup database tidak berisi bytes Drive. Uji restore di lingkungan terisolasi, cocokkan ID/ukuran/checksum, lalu lakukan rekonsiliasi dan uji akses dua tenant sebelum pemulihan diterima.

### Rekonsiliasi, pencabutan dan rotasi

Admin menjalankan Rekonsiliasi setelah gangguan dan secara berkala. Implementasi ini belum memiliki cron global rekonsiliasi otomatis. Tinjau file missing/karantina, orphan serta pekerjaan cleanup gagal/dead; file bisnis tidak dihapus otomatis.

Saat merotasi AES, tambahkan key baru dengan mempertahankan key lama, ganti active ID, deploy, lalu lakukan rotasi koneksi/upload per tenant dan verifikasi sebelum memensiunkan key lama. State OAuth lama perlu diberi waktu kedaluwarsa. Mencabut koneksi lokal tidak otomatis menghapus IAM/akses Google; tindak lanjuti pencabutan remote bila gagal.

### Perubahan dan rollback

Catat versi sumber, deployment, checksum migrasi dan backup sebelum rilis. Gunakan versi deployment terakhir yang terverifikasi untuk rollback aplikasi. Rollback aplikasi tidak membatalkan migrasi database dan tidak mengembalikan bytes Drive. Pemulihan database memerlukan rencana tersendiri; jangan menjalankan reset/drop schema sebagai tindakan rutin.

## Troubleshooting

| Gejala | Langkah pemeriksaan |
|---|---|
| `BUILD_UTILS_SPAWN_1` | Baca error pertama sebelum wrapper; pastikan sumber terbaru memakai `buildCommand: npm run build` |
| Build masih menyebut perintah gabungan lama | Periksa versi unggahan/commit dan Root Directory; redeploy source drop lama tetap membawa file lama |
| Login tampil tetapi proses masuk gagal/503 | Periksa environment, TLS, gateway SSO, application/key, koneksi DB serta keanggotaan lokal |
| Kredensial pusat benar, akses tetap ditolak | Periksa status akun pusat, user lokal, membership tenant atau grant operator |
| `CSRF_DENIED` / `ORIGIN_DENIED` | Pastikan origin/domain sesuai, gunakan cookie/header dari browser yang sama dan muat ulang halaman |
| `TENANT_CONTEXT_CHANGED` | Muat ulang form setelah switch tenant; periksa lembaga aktif sebelum menyimpan |
| `VERSION_CONFLICT` | Ambil data/versi terbaru, bandingkan perubahan dan tinjau ulang sebelum submit |
| Drive gagal Test Koneksi | Periksa mode credential, izin folder/Shared Drive, root unik, callback OAuth dan kemampuan cleanup |
| Upload terputus | Pilih file asli, tunggu lease dan gunakan recovery offset; periksa status sebelum retry |
| File diarsipkan tidak bisa difinalisasi | Status arsip memang menutup kelanjutan upload; jangan memaksakan status `ready` melalui SQL |
| Approved tetapi gagal posting | Keadaan sumber berubah atau aturan belum terpenuhi; ikuti revisi/persetujuan baru yang sah |
| Penyusutan dikecualikan | Periksa policy, umur manfaat, tanggal mulai, status aset, residu dan periode yang sudah dijurnal |
| Laporan terlalu besar | Persempit filter atau kurangi kolom/catatan; ekspor berlebih ditolak, bukan dipotong diam-diam |
| Kamera QR tidak dapat dibuka | Periksa HTTPS, izin kamera dan dukungan perangkat; gunakan input manual |

Untuk laporan masalah, sertakan versi aplikasi, waktu, langkah reproduksi, halaman/endpoint, HTTP/kode error publik, tenant yang ditampilkan, versi dokumen, dan request/correlation ID bila tersedia. Jangan menyertakan password, cookie, private key, token, URL resumable atau connection string.

## Struktur proyek

| Lokasi | Isi |
|---|---|
| `src/app` | Halaman dan route API Next.js |
| `src/features` | Controller, service, schema dan UI per modul |
| `src/lib` | Keamanan, sesi, SSO, PostgreSQL dan integrasi Drive |
| `supabase/migrations` | SQL berurutan dan invariant database |
| `deployment` | Provisioning login dan checksum migrasi |
| `scripts` | Migrasi, bootstrap operator, deployment dan pemeriksaan |
| `tests` | Fixture dan pengujian lokal |
| `assets/fonts` | Font untuk PDF/label beserta lisensinya |
| `docs` | Panduan teknis, operasional, laporan dan bukti pengujian |
| `.env.example` | Template environment tanpa credential siap pakai |
| `vercel.json` | Konfigurasi build/hosting Vercel |

## Dokumentasi lanjutan

- [Indeks dokumentasi](docs/tahap-14/00-Indeks.md)
- [Arsitektur](docs/tahap-14/01-Arsitektur.md)
- [Database](docs/tahap-14/02-Database.md)
- [API dan kontrak umum](docs/tahap-14/03-API.md)
- [Katalog 101 route API](docs/tahap-14/API-Routes.md)
- [Integrasi Central SSO](docs/tahap-14/04-Central-SSO.md)
- [Setup Google Drive](docs/tahap-14/05-Google-Drive.md)
- [Onboarding tenant](docs/tahap-14/06-Onboarding-Tenant.md)
- [Panduan pengguna](docs/tahap-14/07-Panduan-Pengguna.md)
- [Panduan admin](docs/tahap-14/08-Panduan-Admin.md)
- [Laporan pengujian](docs/tahap-14/09-Laporan-Pengujian.md)
- [Troubleshooting teknis](docs/tahap-14/10-Troubleshooting.md)
- [Deployment dan rollback](docs/Deployment-Tahap-13.md)
- [Audit/perbaikan 0.14.1](docs/audit/Laporan-Audit.md)
- [Perbaikan build 0.14.2](docs/Perbaikan-Build-Vercel-0.14.2.md)
- [Status penerimaan](docs/STATUS-PENERIMAAN.md)

Tautan di atas dapat dibuka setelah README ditempatkan pada root paket sumber. Tidak ada lisensi distribusi umum yang dinyatakan pada paket ini; tetapkan kebijakan organisasi sebelum membagikan sumber atau data.

## Batas verifikasi

| Pemeriksaan terakhir | Hasil dan batas |
|---|---|
| Audit 0.14.1 | 320 tes aplikasi dan 47 tes database lulus; database memakai PGlite/provider tiruan |
| Pemeriksaan tambahan | 5 validator deployment, 1 guard target migrasi, 5 smoke browser dan 2 fixture komponen browser lulus |
| Build 0.14.2 | Perintah build baru lulus lokal tanpa konfigurasi layanan runtime; validator tetap menolak konfigurasi kosong |
| Audit dependency terakhir | Produksi 0 advisory; 4 high pada rantai alat pengembangan masih terbuka |
| Deployment remote | Keberhasilan redeploy terbaru belum diverifikasi |
| Integrasi nyata | Central SSO, Supabase/pooler, Google Drive, E2E terautentikasi dan konkurensi PostgreSQL native belum terverifikasi lengkap |
| Operasional produksi | Backup/restore, monitoring, beban, interoperabilitas Excel native dan kesesuaian format instansi masih memerlukan pemeriksaan |

Angka tersebut merupakan hasil tahap/rilis yang disebut, bukan pengujian baru pada mesin pembaca. Kompilasi berhasil atau halaman login terlihat tidak berarti aplikasi sudah siap menerima data produksi.
