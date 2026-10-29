# 📋 Panduan Migrasi & Handover Operasional — Beacon (Unified Ticket Tracker)

Dokumen ini adalah panduan lengkap untuk melakukan migrasi, instalasi baru (*deployment*), dan operasional harian Project Beacon agar dapat dijalankan dan dikelola dengan mudah oleh tim baru.

---

## 1. Arsitektur & Layanan yang Berjalan

Project Beacon adalah sistem intake insiden, alarm SLA, dan routing notifikasi multi-kanal yang terhubung ke:
* **Database**: PostgreSQL (Database: `ticket_tracker`, User: `dbuser`)
* **Kanal Komunikasi**:
  * Microsoft Teams (Bot Framework & Power Automate Webhook di port `3978`)
  * Telegram Bot (Notifikasi tiket & intake channel)
  * WhatsApp Bot (Baileys multi-device)
  * Email Listener (IMAP Tritronik L2 Support di port `993`)
* **AI & Knowledge**: OpenAI API & Outline Knowledge Base (`cpd.hutabyte.com`)
* **Process Manager**: PM2 (berjalan 24/7 di background dengan auto-restart)

---

## 2. Prasyarat Server (Environment Requirements)

Sebelum menjalankan aplikasi di server baru, pastikan hal-hal berikut sudah terpasang:
* **Sistem Operasi**: Linux (AlmaLinux / Rocky Linux / Ubuntu)
* **Node.js**: Versi `>= 20.x`
* **NPM**: Versi `>= 10.x`
* **PM2**: Versi `>= 5.x` (`npm install -g pm2`)
* **PostgreSQL**: Versi `>= 13.x` (bisa native service atau via Docker)
* **Git**: Terpasang dan terkonfigurasi SSH Key ke GitHub repo

---

## 3. Langkah Migrasi / Pemasangan dari Awal (Fresh Setup)

### Langkah A: Setup Database PostgreSQL

#### Opsi 1: Menggunakan Docker (Sangat Direkomendasikan & Cepat)
Jika server memiliki Docker, jalankan PostgreSQL container dengan persistensi data:
```bash
docker run -d \
  --name beacon-postgres \
  --restart always \
  -p 5432:5432 \
  -e POSTGRES_DB=ticket_tracker \
  -e POSTGRES_USER=dbuser \
  -e POSTGRES_PASSWORD=UTT@PantauTiket \
  -v /var/lib/postgresql/beacon_data:/var/lib/postgresql/data \
  postgres:15
```

#### Opsi 2: Menggunakan PostgreSQL Native Service (Linux)
```bash
# Di terminal Linux (sebagai root / sudo):
sudo dnf install -y postgresql-server postgresql-contrib   # (RHEL/AlmaLinux)
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql

# Buat User dan Database
sudo -u postgres psql -c "CREATE USER dbuser WITH PASSWORD 'UTT@PantauTiket';"
sudo -u postgres psql -c "CREATE DATABASE ticket_tracker OWNER dbuser;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ticket_tracker TO dbuser;"
```

---

### Langkah B: Restore Data dari Backup

Ekstrak file dump `ticket_tracker_backup.sql.gz` lalu restore ke PostgreSQL:
```bash
# 1. Unzip file backup
gunzip -k ticket_tracker_backup.sql.gz

# 2. Restore schema & data
PGPASSWORD="UTT@PantauTiket" psql -U dbuser -h 127.0.0.1 -d ticket_tracker < ticket_tracker_backup.sql
```

---

### Langkah C: Clone Repository & Konfigurasi Aplikasi

```bash
# 1. Clone repository ke folder kerja (misalnya di /srv/projects atau ~/projects)
git clone git@github.com:Hutabyte-Abhinaya-Inovasi/Unified-Ticket-Tracker-Beacon-.git
cd Unified-Ticket-Tracker-Beacon-

# 2. Siapkan file .env (copy dari bundle migrasi atau dari .env.example)
cp /path/ke/bundle/.env .

# 3. Install dependencies
npm install --omit=dev
```

---

### Langkah D: Menjalankan Aplikasi via PM2

```bash
# 1. Jalankan aplikasi dengan nama service 'beacon-tracker'
pm2 start src/index.js --name "beacon-tracker"

# 2. Simpan daftar proses PM2 agar otomatis hidup kembali saat server reboot
pm2 save
pm2 startup
# (Jalankan perintah sudo yang ditampilkan oleh 'pm2 startup' jika diminta)
```

---

## 4. Panduan Operasional Harian (Runbook untuk Tim Baru)

| Kebutuhan | Perintah |
| :--- | :--- |
| **Cek status aplikasi** | `pm2 status` |
| **Melihat log real-time** | `pm2 logs beacon-tracker` |
| **Melihat 100 baris log terakhir** | `pm2 logs beacon-tracker --lines 100` |
| **Restart aplikasi** | `pm2 restart beacon-tracker` |
| **Stop aplikasi sementara** | `pm2 stop beacon-tracker` |
| **Update code terbaru dari Git** | `git pull origin main && npm install && pm2 restart beacon-tracker` |

---

## 5. Prosedur Backup Rutin Database

Untuk melakukan backup database berkala secara manual:
```bash
PGPASSWORD="UTT@PantauTiket" pg_dump -U dbuser -h 127.0.0.1 ticket_tracker | gzip > ticket_tracker_backup_$(date +%F).sql.gz
```

