-- Jalankan di Supabase SQL Editor
-- Tambah kolom SLA ke tabel Unified_Ticket_Tracker

ALTER TABLE "Unified_Ticket_Tracker"
  ADD COLUMN IF NOT EXISTS confirmed_at         TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sla_warned           BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_alerted          BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_deadline_minutes INTEGER     DEFAULT NULL;

-- Index agar query SLA worker lebih cepat
CREATE INDEX IF NOT EXISTS idx_utt_sla
  ON "Unified_Ticket_Tracker" (status, confirmed_at)
  WHERE status = 'In Progress' AND confirmed_at IS NOT NULL;
