-- SAH-92 bounce-back: finish the per-guest split flow.
-- Adds WhatsApp phone capture for the guest, a notification audit
-- timestamp, and the payment_split_mode column on bookings the original
-- ticket specced. The pending_split status is reserved here as a future
-- value but no flow uses it yet (bzo marked the pre-pay flow optional).

ALTER TABLE public.booking_guests
    ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT,
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS payment_split_mode TEXT
        NOT NULL DEFAULT 'full'
        CHECK (payment_split_mode IN ('full', 'split_post'));
