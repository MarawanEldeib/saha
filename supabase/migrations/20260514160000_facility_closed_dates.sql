-- =============================================================================
-- SAH-91 final piece: facility-declared closed dates.
-- Owner enters dates the facility is closed (holidays, maintenance, Eid,
-- etc.). A daily cron sweeps confirmed future bookings on these dates,
-- cancels them, refunds the player, and fires the notification.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.facility_closed_dates (
    facility_id  UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    closed_date  DATE NOT NULL,
    reason       TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    PRIMARY KEY (facility_id, closed_date)
);

CREATE INDEX IF NOT EXISTS facility_closed_dates_date_idx
    ON public.facility_closed_dates (closed_date);

ALTER TABLE public.facility_closed_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fcd_select_public" ON public.facility_closed_dates;
CREATE POLICY "fcd_select_public" ON public.facility_closed_dates
    FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "fcd_owner_write" ON public.facility_closed_dates;
CREATE POLICY "fcd_owner_write" ON public.facility_closed_dates
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.facilities f
            WHERE f.id = facility_closed_dates.facility_id
              AND (f.owner_id = auth.uid() OR public.is_admin())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.facilities f
            WHERE f.id = facility_closed_dates.facility_id
              AND (f.owner_id = auth.uid() OR public.is_admin())
        )
    );
