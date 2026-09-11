-- Segmented meeting transcription: per-segment progress lives on the meeting row
-- so any worker (or the poller) can resume the job where the last one stopped.
alter table public.focusos_meetings
  add column if not exists transcript_segments jsonb;

comment on column public.focusos_meetings.transcript_segments is
  'Segmented transcription state: { total, chunkCount, segmentChunks, initReady, texts: {"0":"..."}, attempts: {"0":n}, resumes, lease: {segment,until}|null }. NULL until the first transcribe worker plans the segments.';
