-- ============================================================
-- MIGRATION: Tambah kolom untuk pipeline ke tabel intake_message
-- yang sudah ada + kolom baru di Unified_Ticket_Tracker
-- Jalankan di Supabase SQL Editor
-- ============================================================

-- ── 1. Tambah kolom pipeline ke intake_message ───────────────
-- Kolom berikut tidak ada di definisi awal tabel,
-- tapi diperlukan oleh processor untuk tracking status pesan.

ALTER TABLE public.intake_message
  ADD COLUMN IF NOT EXISTS status        TEXT        DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS processed_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ignore_reason TEXT        DEFAULT NULL;

-- ── 2. Tambah kolom ke Unified_Ticket_Tracker ────────────────
ALTER TABLE "Unified_Ticket_Tracker"
  ADD COLUMN IF NOT EXISTS group_id         TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_message_at  TIMESTAMPTZ DEFAULT NULL;

-- ── 3. Index untuk performa ───────────────────────────────────

-- Cari pesan pending (batch processor)
CREATE INDEX IF NOT EXISTS idx_intake_status
  ON public.intake_message (status);

-- Cari pesan per grup + status
CREATE INDEX IF NOT EXISTS idx_intake_source_ref_status
  ON public.intake_message (source_ref, status);

-- Cari pesan via idempotency_key (untuk thread_ref lookup)
CREATE INDEX IF NOT EXISTS idx_intake_idempotency_key
  ON public.intake_message (idempotency_key);

-- Cari semua raw yang terkait satu tiket
CREATE INDEX IF NOT EXISTS idx_intake_ticket_id
  ON public.intake_message (ticket_id);

-- Cari tiket aktif per grup
CREATE INDEX IF NOT EXISTS idx_utt_group_id_status
  ON "Unified_Ticket_Tracker" (group_id, status);

-- ── Verifikasi ───────────────────────────────────────────────
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'intake_message'
-- ORDER BY ordinal_position;
