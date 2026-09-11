# Segmented meeting transcription — part 2 of 2

Finishes the segmented transcription rollout: new meetings created from chunked recordings no longer depend on a whole-file Gemini upload, and the MCP `list_meetings` tool stops erroring on a column that does not exist.

## Verified current state

- Part 1 is live: `transcript_segments` appears in regenerated `src/integrations/supabase/types.ts`, and `supabase/functions/_shared/gcs.ts` + `gemini.ts` (which the new file imports) exist.
- `supabase/functions/focusos-mcp/index.ts` line 249 currently reads `.select("id, title, status, created_at, summary")` — `focusos_meetings` has no `status` column, so `list_meetings` fails today.
- `supabase/functions/focusos-process-meeting/index.ts` exists (26 KB) and will be fully replaced.

## Order of work

1. **Replace** `supabase/functions/focusos-process-meeting/index.ts` verbatim with the supplied 13,943-char file. In the chunked-session flow it still composes `recording.webm` in GCS (playback/download need it) but skips the whole-file Gemini upload; new meeting rows are inserted with `processing_status = 'transcribing'`, `gemini_file_uri = null`, `transcript_segments = null`. The legacy `audioBase64` flow and the resummarize flow are unchanged.
2. **One-line edit** in `supabase/functions/focusos-mcp/index.ts` (line 249, inside `list_meetings`): replace the select with `.select("id, title, processing_status, processing_error, duration_seconds, created_at, summary")`. Nothing else in the file changes.
3. **Deploy** only `focusos-process-meeting` and `focusos-mcp`.
4. **Verify acceptance:**
   - (a) Call the MCP `list_meetings` tool and confirm rows return with no "column focusos_meetings.status does not exist" error.
   - (b) Both functions deployed from these exact sources.
   - (c) Diff confirms only these two function files changed — no `src/`, no schema, no RLS, no data updates, no reformatting.

## Out of scope

No frontend changes, no migrations, no other edge functions, no config.toml.
