-- ============================================================
-- MIGRATION: SLA Konfirmasi 15 Menit + Intake ID
-- Jalankan di Supabase SQL Editor → hutabyte project
-- ============================================================

-- ── 1. Tambah kolom SLA Konfirmasi ke Unified_Ticket_Tracker ─
ALTER TABLE "Unified_Ticket_Tracker"
  -- Waktu pertama kali notifikasi kandidat dikirim ke Telegram
  -- Digunakan sebagai START dari SLA Konfirmasi 15 Menit
  ADD COLUMN IF NOT EXISTS intake_received_at       TIMESTAMPTZ DEFAULT NULL,

  -- Flag: sudah dikirim peringatan SLA konfirmasi (misal 10 menit tanpa konfirmasi)
  ADD COLUMN IF NOT EXISTS sla_confirm_warned       BOOLEAN     DEFAULT FALSE,

  -- Flag: SLA konfirmasi sudah habis (15 menit tanpa konfirmasi) → notif eskalasi
  ADD COLUMN IF NOT EXISTS sla_confirm_alerted      BOOLEAN     DEFAULT FALSE,

  -- Siapa yang mengkonfirmasi tiket (nama Telegram user)
  ADD COLUMN IF NOT EXISTS confirmed_by             TEXT        DEFAULT NULL,

  -- Siapa yang menolak tiket / menandai bukan tiket
  ADD COLUMN IF NOT EXISTS rejected_by              TEXT        DEFAULT NULL,

  -- Waktu ketika tiket ditolak (ditandai Bukan Tiket)
  ADD COLUMN IF NOT EXISTS rejected_at              TIMESTAMPTZ DEFAULT NULL;

-- ── 2. Index untuk performa query SLA Konfirmasi ─────────────
-- Digunakan oleh checkSlaConfirmation() di slaWorker.js
CREATE INDEX IF NOT EXISTS idx_utt_sla_confirmation
  ON "Unified_Ticket_Tracker" (status, intake_received_at)
  WHERE status = 'Pending Confirmation' AND intake_received_at IS NOT NULL;

-- ── 3. Verifikasi kolom yang sudah ada ───────────────────────
-- Kolom berikut SUDAH ADA dari migration sebelumnya (migration_add_sla_fields.sql):
--   confirmed_at         → waktu L1 klik "Ini Tiket" → START SLA Pekerjaan 2 Jam ✅
--   sla_warned           → peringatan SLA Pekerjaan ✅
--   sla_alerted          → alarm SLA Pekerjaan habis ✅
--   sla_deadline_minutes → batas waktu SLA (menit) ✅

-- Kolom berikut SUDAH ADA dari migration_add_raw_ticket_link.sql:
--   group_id             → ID grup/channel ✅
--   last_message_at      → waktu pesan terakhir ✅

-- ── 4. (Opsional) Update SLA Pekerjaan untuk tiket yang sudah ada ────
-- Jika ada tiket In Progress yang belum punya sla_deadline_minutes,
-- set default ke 120 menit (2 jam):
UPDATE "Unified_Ticket_Tracker"
SET sla_deadline_minutes = 120
WHERE status = 'In Progress'
  AND sla_deadline_minutes IS NULL;
