-- Segmented meeting transcription: per-segment progress lives on the meeting row
-- so any worker (or the poller) can resume the job where the last one stopped.
alter table public.focusos_meetings
  add column if not exists transcript_segments jsonb;

comment on column public.focusos_meetings.transcript_segments is
  'Segmented transcription state: { total, chunkCount, segmentChunks, initReady, texts: {"0":"..."}, attempts: {"0":n}, resumes, lease: {segment,until,token} }. NULL until the first transcribe worker plans the segments. The lease is ALWAYS an object, never json null: a released lease is the sentinel {segment:-1,until:"1970-01-01T00:00:00.000Z",token:""} because the worker claims a segment with the plain filter lease->>until < now (an or= tree on a PATCH is rejected by PostgREST) and a null there would match no row.';
