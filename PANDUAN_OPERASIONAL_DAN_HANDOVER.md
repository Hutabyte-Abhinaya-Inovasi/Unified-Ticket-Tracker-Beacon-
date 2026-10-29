# 📘 BUKU PANDUAN OPERASIONAL & SERAH TERIMA (HANDOVER)
## Project Beacon — Unified Ticket Tracker (Hutabot AI)

> **Dokumen Resmi Serah Terima Sistem (Handover Runbook)**  
> **Target Pengguna:** Operator IT, DevOps, Software Engineer, atau PIC Baru yang akan mengelola sistem Beacon.  
> **Tanggal Pembaruan:** 29 Oktober 2026  
> **Status Sistem:** Aktif di Production (Production Live)

---

## DAFTAR ISI
1. [Ringkasan Sistem & Arsitektur](#1-ringkasan-sistem--arsitektur)
2. [Data Akses Server & Kredensial Lengkap (PENTING)](#2-data-akses-server--kredensial-lengkap-penting)
3. [Struktur Folder & Penempatan File](#3-struktur-folder--penempatan-file)
4. [Panduan Operasional Harian (Cheatsheet)](#4-panduan-operasional-harian-cheatsheet)
5. [Langkah-Langkah Menjalankan Ulang / Deploy dari Nol](#5-langkah-langkah-menjalankan-ulang--deploy-dari-nol)
6. [Tanda-Tanda Sistem Berjalan Normal (Indikator Berhasil)](#6-tanda-tanda-sistem-berjalan-normal-indikator-berhasil)
7. [Tanda-Tanda Masalah & Solusi Mengatasinya (Troubleshooting)](#7-tanda-tanda-masalah--solusi-mengatasinya-troubleshooting)
8. [Prosedur Pembaruan Kode (Update Code / Git Pull)](#8-prosedur-pembaruan-kode-update-code--git-pull)
9. [Prosedur Backup & Restore Database](#9-prosedur-backup--restore-database)

---

## 1. Ringkasan Sistem & Arsitektur

Project **Beacon (Unified Ticket Tracker)** adalah sistem intake insiden operasional terpusat yang bekerja otomatis 24/7 untuk memastikan tidak ada tiket atau laporan klien yang terlewat.

```
       [Kanal Masuk]                         [Inti Sistem]                    [Kanal Keluar]
   ┌───────────────────────┐                                            ┌───────────────────────┐
   │ 📧 Email Tritronik   │ ────┐                                  ┌───>│ 📢 MS Teams Channel   │
   │    (IMAP Port 993)    │     │   ┌──────────────────────────┐   │    │    (Notifikasi Tiket)│
   ├───────────────────────┤     ├──>│ 🤖 Beacon Node.js Engine │───┤    ├───────────────────────┤
   │ 💬 Telegram Groups   │ ────┤   │    (Port internal: 3978) │   ├───>│ 💬 Hutabot AI Teams   │
   │    (Bot Polling)      │     │   └────────────┬─────────────┘   │    │    (Chat interaktif)  │
   ├───────────────────────┤     │                │                 │    ├───────────────────────┤
   │ 👥 MS Teams Webhook   │ ────┤                │                 └───>│ 📑 Database Local     │
   │    (https://.../api)  │     │   ┌────────────┴─────────────┐        │    (PostgreSQL 5432)  │
   └───────────────────────┘     └──>│ 🧠 AI & Knowledge Engine │        └───────────────────────┘
                                     │ - OpenAI API (GPT)       │
                                     │ - Outline CPD Hutabyte   │
                                     └──────────────────────────┘
```

---

## 2. Data Akses Server & Kredensial Lengkap (PENTING)

Simpan kredensial ini di tempat aman (misal: Password Manager tim).

### A. Akses Server VPS Production (Contabo)
* **IP Server:** `46.250.227.98`
* **Port SSH:** `19123`
* **Sistem Operasi:** AlmaLinux 9.8 (RHEL-based)
* **Akun 1 (Pemilik Project / Daily Runner):**
  * **User:** `kevin`
  * **Password:** `Hutabyte#Doloksanggul123`
  * **Peran:** Menjalankan bot via PM2, menyimpan file project.
* **Akun 2 (Administrator / Sudoer):**
  * **User:** `itsupport`
  * **Password:** `Hutabyte#Toba123`
  * **Peran:** Konfigurasi sistem, instalasi paket, konfigurasi Apache dan firewall.

### B. Database PostgreSQL (Lokal di VPS)
* **Host:** `127.0.0.1`
* **Port:** `5432`
* **Nama Database:** `ticket_tracker`
* **User Database:** `dbuser`
* **Password Database:** `UTT@PantauTiket`
* **Superuser Root:** `postgres` (dapat diakses tanpa password via `sudo -u postgres psql` dari akun `itsupport`).

### C. Web Server & Endpoint Microsoft Teams
* **Web Server:** Apache 2.4 (`httpd`)
* **Domain:** `https://hutabyte.com`
* **Reverse Proxy Teams Endpoint:**
  * `https://hutabyte.com/api/messages` ➡️ `http://127.0.0.1:3978/api/messages`
  * `https://hutabyte.com/api/workflows` ➡️ `http://127.0.0.1:3978/api/workflows`
* **File Konfigurasi Apache:** `/etc/httpd/conf.d/hutabyte.conf`

### D. Kredensial Eksternal (Tersimpan di `.env` Server)
> *Catatan Keamanan: Nilai lengkap token API tersimpan aman di file `/home/kevin/Unified-Ticket-Tracker-Beacon-/.env` pada server.*

* **Email IMAP Tritronik:**
  * Host: `rama.tritronik.com` | Port: `993` | Secure: `true`
  * User: `l2.support@tritronik.com`
  * Password: `PVb0By1z6z75` (atau cek di `.env`)
* **Telegram Bot:**
  * Bot Token: `8867326401:AAHp***` *(nilai lengkap di `.env`)*
  * Grup Operasi: `-1003753882093`, `-5546265953`
* **Microsoft Teams Bot Framework:**
  * App ID: `26574032-7b88-4866-9ff3-37bf7df0a181`
  * App Password: *(Tersimpan di `.env` parameter `MICROSOFT_APP_PASSWORD`)*
  * Tenant ID: `e66d53eb-7157-4115-a05e-f14a6c7a432b`
* **Outline Knowledge Base:**
  * Base URL: `https://cpd.hutabyte.com`
  * Collection: `PT Tricada Intronik` (`bfc3f584-d33a-41c9-b7b0-cf00c88e619a`)

---

## 3. Struktur Folder & Penempatan File

Semua file project berada di dalam home directory user **`kevin`**:

```text
/home/kevin/Unified-Ticket-Tracker-Beacon-/
├── .env                              # Kredensial asli production (RAHASIA, JANGAN DIHAPUS)
├── .env.example                      # Template referensi variabel konfigurasi
├── MIGRATION_RUNBOOK.md              # Riwayat dan panduan teknis migrasi
├── PANDUAN_OPERASIONAL_DAN_HANDOVER.md # Dokumen panduan ini
├── package.json                      # Daftar dependencies Node.js (v20+)
├── package-lock.json
├── src/
│   ├── index.js                      # Entrypoint utama aplikasi
│   ├── config/
│   │   └── env.js                    # Loader & validator konfigurasi .env
│   ├── infrastructure/
│   │   ├── teams/                    # Server Express port 3978 & Bot Framework
│   │   ├── telegram/                 # Telegram Bot listener & notifier
│   │   ├── whatsapp/                 # WhatsApp Baileys engine
│   │   ├── email/                    # IMAP email listener Tritronik
│   │   └── ai/                       # Integrasi OpenAI & Outline RAG
│   └── database/
│       ├── postgresClient.js         # Koneksi pool ke PostgreSQL lokal
│       └── supabase.js               # Kompatibilitas query database
```

---

## 4. Panduan Operasional Harian (Cheatsheet)

Login ke server menggunakan SSH:
```bash
ssh -p 19123 kevin@46.250.227.98
# Password: Hutabyte#Doloksanggul123
```

### A. Melihat Status Bot
```bash
pm2 status
```
*Pastikan baris `beacon-tracker` berstatus **`online`**.*

### B. Membaca Log Berjalan (Real-time)
```bash
# Pantau log secara langsung
pm2 logs beacon-tracker

# Lihat 100 baris log terakhir
pm2 logs beacon-tracker --lines 100

# Lihat hanya log error
pm2 logs beacon-tracker --err --lines 50
```

### C. Merestart Bot (Misal setelah ubah .env atau update kode)
```bash
pm2 restart beacon-tracker
```

### D. Menghentikan & Menyalakan Bot
```bash
# Menghentikan
pm2 stop beacon-tracker

# Menyalakan kembali
pm2 start beacon-tracker
```

### E. Mengecek Database Secara Langsung
```bash
PGPASSWORD="UTT@PantauTiket" psql -U dbuser -h 127.0.0.1 -d ticket_tracker -c "SELECT count(*) FROM \"Unified_Ticket_Tracker\";"
```

---

## 5. Langkah-Langkah Menjalankan Ulang / Deploy dari Nol

Jika suatu hari server ter-reset atau aplikasi mati total, ikuti langkah ini:

### Langkah 1: Pastikan Service PostgreSQL Hidup
```bash
systemctl status postgresql
# Jika mati, nyalakan (lewat itsupport):
sudo systemctl enable --now postgresql
```

### Langkah 2: Masuk ke Folder Project
```bash
cd /home/kevin/Unified-Ticket-Tracker-Beacon-
```

### Langkah 3: Pastikan Node.js v20 & Dependensi Siap
```bash
node -v   # Wajib v20.x
npm install --omit=dev
```

### Langkah 4: Jalankan Aplikasi Menggunakan PM2
```bash
pm2 start src/index.js --name "beacon-tracker" --node-args="--dns-result-order=ipv4first"
pm2 save
```

---

## 6. Tanda-Tanda Sistem Berjalan Normal (Indikator Berhasil)

Bagaimana cara memastikan sistem 100% sehat tanpa membuka code?

| Area | Cara Cek | Tanda Berhasil (Normal) |
| :--- | :--- | :--- |
| **Status PM2** | `pm2 status` | Kolom `status` bernilai **`online`**, memory berkisar **100MB – 400MB**, dan kolom `restart (↺)` tidak bertambah terus menerus. |
| **Log Aplikasi** | `pm2 logs beacon-tracker` | Muncul log rutin: <br>• `[SLA-Konfirmasi] Memeriksa ... intake pending`<br>• `📨 EMAIL BARU DITERIMA`<br>• `[Teams] ✅ Pesan berhasil dikirim ke Teams (HTTP 202)` |
| **Endpoint Teams** | `curl -i https://hutabyte.com/api/messages` | Mengembalikan **`HTTP/1.1 200 OK`** dan JSON `{"status":"ready",...}`. |
| **Chat Teams** | Buka Microsoft Teams ➡️ Chat **Hutabot AI** | Kirim pesan: `halo ai` atau `apakah ada kandidat tiket hari ini?`<br>Bot **membalas dalam 2–5 detik** berisi daftar nomor tiket. |
| **Channel Teams** | Buka Channel **Alert & Notification Center** | Kartu notifikasi tiket baru (Adaptive Card) masuk secara otomatis setiap kali ada email insiden masuk ke `l2.support@tritronik.com`. |

---

## 7. Tanda-Tanda Masalah & Solusi Mengatasinya (Troubleshooting)

### Kasus 1: Bot di PM2 Statusnya `errored` atau `restarting` Terus Menerus
* **Gejala:** Nilai `restart (↺)` pada `pm2 status` naik terus (10, 20, 50...) dan status berubah-ubah antara `online` dan `errored`.
* **Penyebab Utama:**
  1. File `.env` hilang atau tidak terbaca.
  2. Database PostgreSQL mati atau password salah.
* **Cara Cek & Solusi:**
  1. Buka log error: `pm2 logs beacon-tracker --err --lines 30`.
  2. Jika error koneksi database (`ECONNREFUSED 127.0.0.1:5432`):
     ```bash
     # Cek PostgreSQL:
     sudo systemctl status postgresql
     sudo systemctl start postgresql
     ```
  3. Cek keberadaan `.env`:
     ```bash
     ls -la /home/kevin/Unified-Ticket-Tracker-Beacon-/.env
     ```

---

### Kasus 2: Chat di Teams ke "Hutabot AI" Tidak Dibalas (Padahal Notifikasi Channel Masuk)
* **Gejala:** Pesan personal ke Hutabot AI di Teams tidak dijawab sama sekali.
* **Penyebab:** Permintaan dari server Microsoft Teams gagal diteruskan oleh Apache ke port `3978`.
* **Cara Cek:**
  Jalankan di terminal:
  ```bash
  curl -i https://hutabyte.com/api/messages
  ```
  * **Jika output `404 Not Found`:** Konfigurasi Reverse Proxy Apache terhapus/hilang.
  * **Jika output `503 Service Unavailable`:** SELinux memblokir Apache atau bot port 3978 mati.
* **Solusi Cepat:**
  Login sebagai `itsupport`:
  ```bash
  # 1. Pastikan SELinux mengizinkan proxy Apache:
  sudo setsebool -P httpd_can_network_connect 1

  # 2. Cek apakah di /etc/httpd/conf.d/hutabyte.conf sudah ada baris ini:
  #    ProxyPass /api/messages http://127.0.0.1:3978/api/messages
  #    ProxyPassReverse /api/messages http://127.0.0.1:3978/api/messages

  # 3. Reload Apache:
  sudo systemctl reload httpd
  ```

---

### Kasus 3: Log Menampilkan `[CONFLICT 409] Instance lain terdeteksi`
* **Gejala:** Di log PM2 muncul pesan peringatan berulang: `CONFLICT 409: Instance lain terdeteksi — menghentikan polling sementara...`.
* **Penyebab:** Ada bot Beacon lain (misalnya di server lama atau di laptop lokal developer) yang sedang menyala menggunakan Token Telegram yang sama.
* **Solusi:**
  1. Pastikan VPS lama atau komputer developer tidak menyalakan bot:
     ```bash
     # Di server lama:
     pm2 stop all
     ```
  2. Begitu instance lama mati, bot di VPS ini akan otomatis memunculkan:
     `✅ [CONFLICT RESOLVED] Polling berhasil diambil alih!`.

---

### Kasus 4: Email Baru Tidak Masuk ke Tiket
* **Gejala:** Ada email masuk ke `l2.support@tritronik.com`, tapi tidak muncul di Teams dan tidak ada log `📨 EMAIL BARU DITERIMA`.
* **Penyebab:** Koneksi IMAP ke server email `rama.tritronik.com:993` terputus atau password email berubah.
* **Solusi:**
  1. Cek koneksi port 993:
     ```bash
     nc -zv -w 5 rama.tritronik.com 993
     ```
  2. Cek apakah password email di `.env` (`EMAIL_PASS`) masih valid dengan mencoba login ke webmail Tritronik.
  3. Restart bot: `pm2 restart beacon-tracker`.

---

## 8. Prosedur Pembaruan Kode (Update Code / Git Pull)

Jika ada developer yang melakukan update fitur dan melakukan push ke GitHub branch `main`:

Jalankan 4 perintah ini di server:
```bash
# 1. Masuk ke folder project
cd /home/kevin/Unified-Ticket-Tracker-Beacon-

# 2. Ambil update terbaru dari GitHub
git pull origin main

# 3. Install paket jika ada dependensi baru di package.json
npm install --omit=dev

# 4. Muat ulang bot agar kode baru langsung aktif
pm2 restart beacon-tracker
```

---

## 9. Prosedur Backup & Restore Database

### A. Melakukan Backup Rutin (Dump Database)
Jalankan perintah ini kapan saja untuk mengekspor database ke file `.sql.gz`:
```bash
PGPASSWORD="UTT@PantauTiket" pg_dump -U dbuser -h 127.0.0.1 ticket_tracker | gzip > ~/backup_ticket_tracker_$(date +%F_%H%M).sql.gz
```
File backup akan tersimpan di home folder Kevin (`/home/kevin/`).

### B. Merestore Database dari Backup
Jika database rusak atau ingin dikembalikan ke titik tertentu:
```bash
# 1. Hentikan bot sementara
pm2 stop beacon-tracker

# 2. Decompress file backup (jika berekstensi .gz)
gunzip -k backup_ticket_tracker_xxxx.sql.gz

# 3. Restore ke PostgreSQL
PGPASSWORD="UTT@PantauTiket" psql -U dbuser -h 127.0.0.1 -d ticket_tracker < backup_ticket_tracker_xxxx.sql

# 4. Nyalakan kembali bot
pm2 start beacon-tracker
```

---

## 10. Kontak Bantuan & Eskalasi

* **Repository GitHub:** [Hutabyte-Abhinaya-Inovasi/Unified-Ticket-Tracker-Beacon-](https://github.com/Hutabyte-Abhinaya-Inovasi/Unified-Ticket-Tracker-Beacon-)
* **PIC Server & DevOps Hutabyte:** Kevin Situmorang / Bang Fahrezy H
* **Tim Support:** Tritronik L2 Support Operations
