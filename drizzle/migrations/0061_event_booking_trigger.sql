-- Event bookings (source='event') have null service_id/area_id — GA tickets
-- have neither. Derive org/venue from the special event instead. Standard
-- bookings keep the service+area derivation unchanged. Replaces the function
-- body from migration 0004; the existing trigger binding is preserved by
-- CREATE OR REPLACE. See docs/specs/special-events.md Phase 2.
CREATE OR REPLACE FUNCTION public.enforce_bookings_org_and_venue()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  svc_org uuid;
  svc_venue uuid;
  area_venue uuid;
  ev_org uuid;
  ev_venue uuid;
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    SELECT e.organisation_id, e.venue_id INTO ev_org, ev_venue
    FROM public.special_events e WHERE e.id = NEW.event_id;
    IF ev_org IS NULL THEN
      RAISE EXCEPTION 'enforce_bookings_org_and_venue: event % not found', NEW.event_id;
    END IF;
    NEW.organisation_id := ev_org;
    NEW.venue_id := ev_venue;
    RETURN NEW;
  END IF;

  SELECT s.organisation_id, s.venue_id INTO svc_org, svc_venue
  FROM public.services s WHERE s.id = NEW.service_id;
  IF svc_org IS NULL THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: service % not found', NEW.service_id;
  END IF;
  NEW.organisation_id := svc_org;
  NEW.venue_id := svc_venue;

  SELECT a.venue_id INTO area_venue FROM public.areas a WHERE a.id = NEW.area_id;
  IF area_venue IS NULL THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: area % not found', NEW.area_id;
  END IF;
  IF area_venue <> svc_venue THEN
    RAISE EXCEPTION 'enforce_bookings_org_and_venue: area % belongs to a different venue than service %', NEW.area_id, NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$;
