# Segmented meeting transcription — part 1 of 2

Long meetings currently go to Gemini as one giant call inside a single edge worker, which runs out of time. This change transcribes a recording in 10-minute pieces, saving progress after each piece, so a long meeting can finish across several short runs.

## Verified current state

- `supabase/functions/_shared/` does not exist yet — all three shared modules are new files.
- `transcript_segments` does not appear in `src/integrations/supabase/types.ts`, so the column has to be added.
- `supabase/config.toml` has no `[functions.focusos-transcribe-meeting]` block, so it keeps the default `verify_jwt = true`. The new worker's own owner/service-key check matches that. config.toml stays untouched.

## Order of work

1. **Migration first.** Add `transcript_segments jsonb` (nullable) plus the column comment to `public.focusos_meetings`, exactly as supplied. Additive only — no RLS, no grants change, no row updates. Types are regenerated automatically afterwards.
2. **Create the three shared modules** verbatim at `supabase/functions/_shared/segments.ts`, `gcs.ts`, `gemini.ts` so the relative `../_shared/x.ts` imports bundle with each function.
3. **Replace the two functions** verbatim: `focusos-transcribe-meeting/index.ts` and `focusos-poll-stuck-meetings/index.ts`.
4. **Deploy** only `focusos-transcribe-meeting` and `focusos-poll-stuck-meetings`, after the migration has applied.
5. **Verify acceptance:** confirm the column exists; POST an empty JSON body to `focusos-transcribe-meeting` and confirm a 400 containing "Missing meetingId"; confirm the git diff touches only these six files (plus regenerated types).

## One deviation to note

The migration is applied through the platform's migration tool, which names the file itself (`<timestamp>_<uuid>.sql`). The SQL will be byte-identical to the supplied file, but the filename will not be `20260911100000_transcript_segments.sql`. Same as the previous wallpaper/sort-order migrations. Nothing else deviates.

## Out of scope

No `src/` changes (other than auto-regenerated `types.ts`), no other edge functions, no `focusos-process-meeting` changes (part 2), no config.toml, no data backfill.
