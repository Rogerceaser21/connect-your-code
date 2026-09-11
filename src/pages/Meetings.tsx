import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchProjects as fetchProjectsShared, appDataKeys, APP_DATA_STALE_TIME, APP_DATA_GC_TIME } from '@/lib/appDataFetchers';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ArrowLeft, Mic, MicOff, Clock, FileText, ChevronRight, Plus, Folder, Square, Loader2, X, UserPlus, Trash2, Pause, Play, RefreshCw, Share2 } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { ProjectsDrawerHost } from '@/components/ProjectsDrawerHost';
import RecordFAB from '@/components/RecordFAB';
import { BrainDumpLiveDialog } from '@/components/BrainDumpLiveDialog';
import { MeetingsTour } from '@/components/MeetingsTour';
import { DEMO_MEETING_ID } from '@/lib/demoMeeting';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';

interface Participant {
  name: string;
  email: string;
}

/**
 * The segmented transcriber's progress ledger (focusos_meetings.transcript_segments).
 * Written segment by segment while the worker runs: `total` is the planned segment
 * count, `texts` holds one entry per finished segment keyed by its index. Either half
 * can be missing — the column is null until the worker has planned the run.
 */
interface TranscriptSegments {
  total?: number;
  texts?: Record<string, string>;
}

interface Meeting {
  id: string;
  title: string;
  duration_seconds: number;
  summary: string | null;
  action_items: any[];
  project_id: string | null;
  created_at: string;
  updated_at?: string;
  processing_status?: string;
  processing_error?: string | null;
  transcript_segments?: TranscriptSegments | null;
}

/**
 * done/total for a transcript_segments blob, or null when the run has no plan yet
 * (column null/absent, no `total`, or a nonsense total: non-numeric, NaN, <= 0).
 * `done` counts the segments that already carry text, so it is 0 on a freshly
 * planned run rather than null, and it is CLAMPED to the plan: a ledger that
 * carries more texts than `total` (a re-planned run, a retry that re-segmented
 * the audio) renders "8/8", never "9/8".
 */
const segmentProgress = (segments: unknown): { done: number; total: number } | null => {
  if (!segments || typeof segments !== 'object') return null;
  const { total, texts } = segments as TranscriptSegments;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;
  const counted = texts && typeof texts === 'object' ? Object.keys(texts).length : 0;
  return { done: Math.min(counted, total), total };
};

interface Project {
  id: string;
  name: string;
  color: string;
}

type RecordingState = 'idle' | 'recording' | 'processing' | 'done';

const PROCESSING_LABELS: Record<string, { label: string; progress: number }> = {
  uploading: { label: 'Uploading audio to AI...', progress: 20 },
  transcribing: { label: 'Transcribing...', progress: 50 },
  summarizing: { label: 'Generating summary...', progress: 80 },
  done: { label: 'Complete!', progress: 100 },
  error: { label: 'Processing failed', progress: 0 },
};

const Meetings = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const shouldOpenNew = searchParams.get('new') === 'true';
  const tourParam = searchParams.get('tour');
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const { preferences, markMeetingsTourComplete } = useUserPreferences(user?.id);

  // Projects drawer, opened OVER this page by the dock (never navigates on open).
  const [projectsDrawerOpen, setProjectsDrawerOpen] = useState(false);

  // Tour state — open if explicitly requested OR auto-launch for first-time users once preferences load
  const [tourOpen, setTourOpen] = useState(false);
  const hasAutoLaunchedMeetingsTourRef = useRef(false);
  useEffect(() => {
    if (tourParam === 'meetings') {
      setTourOpen(true);
      return;
    }
    if (hasAutoLaunchedMeetingsTourRef.current) return;
    if (preferences && !preferences.has_completed_meetings_tour) {
      hasAutoLaunchedMeetingsTourRef.current = true;
      // Auto-launch once for new users — small delay so the page paints first
      const t = setTimeout(() => setTourOpen(true), 600);
      return () => clearTimeout(t);
    }
  }, [tourParam, preferences]);
  // Synchronous warm start: read the shared meetings cache DURING the first render so a
  // cache-hit visit never paints the skeleton (loading=true + post-paint effect used to
  // flash it on every visit). Computed once — useState initializer, not per-render.
  const [warmMeetings] = useState<Meeting[] | null>(() => {
    if (!user || projectId) return null;
    const cached = queryClient.getQueryData(['focusos-meetings', user.id]) as any[] | undefined;
    if (!cached) return null;
    return cached.map((m: any) => ({
      ...m,
      action_items: Array.isArray(m.action_items) ? m.action_items : [],
      processing_status: m.processing_status || 'done',
      processing_error: m.processing_error || null,
      transcript_segments: m.transcript_segments ?? null,
    }));
  });
  const [meetings, setMeetings] = useState<Meeting[]>(warmMeetings ?? []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(warmMeetings === null);
  const [brainDumpOpen, setBrainDumpOpen] = useState(false);

  // Recording state
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Chunked upload state
  const sessionIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);
  const chunkUploadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isUploadingChunkRef = useRef(false);

  // Refs for values needed inside recorder.onstop closure
  const meetingNameRef = useRef('');
  const participantsRef = useRef<Participant[]>([{ name: '', email: '' }, { name: '', email: '' }]);
  const recordingSecondsRef = useRef(0);

  // Participants
  const [participants, setParticipants] = useState<Participant[]>([
    { name: '', email: '' },
    { name: '', email: '' },
  ]);
  const [showParticipants, setShowParticipants] = useState(shouldOpenNew);
  const [meetingName, setMeetingName] = useState('');

  // Delete state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [meetingToDelete, setMeetingToDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Async processing polling state
  const [processingMeetingId, setProcessingMeetingId] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string>('uploading');
  // done/total for the in-flight transcription, or null while the segment plan is
  // unknown — the banner falls back to the count-less label then.
  const [processingProgress, setProcessingProgress] = useState<{ done: number; total: number } | null>(null);

  // Orphaned session recovery
  const [orphanedSession, setOrphanedSession] = useState<{ id: string; chunkCount: number; createdAt: string; gcsFolder: string; mimeType: string } | null>(null);
  const [recoveringSession, setRecoveringSession] = useState(false);
  const failedSessionRef = useRef<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The status poll asks for transcript_segments, which the live table does not carry
  // until the server half of this wave migrates it. PostgREST answers an unknown
  // column with HTTP 400 / code 42703, and a swallowed 400 means the poll never sees
  // 'done' or 'error': no navigate, no toast, the banner spins for ever (Retry, a
  // fresh recording and orphan recovery alike). So the FIRST 42703 downgrades to the
  // two-column select and is remembered here, and every later tick asks the narrow
  // question directly - one 400 per mount, never one per tick. Once the column exists
  // the wide select simply succeeds and this stays false.
  const noSegmentsColumnRef = useRef(false);

  // Meeting sharing info: receiverMeetingId -> { sender name }
  const [meetingSharingMap, setMeetingSharingMap] = useState<Record<string, { name: string }>>({});

  // Keep refs in sync with state
  useEffect(() => { meetingNameRef.current = meetingName; }, [meetingName]);
  useEffect(() => { participantsRef.current = participants; }, [participants]);
  useEffect(() => { recordingSecondsRef.current = recordingSeconds; }, [recordingSeconds]);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      // Try warm cache first for meetings and projects
      const cachedMeetings = queryClient.getQueryData(['focusos-meetings', user.id]) as any[] | undefined;
      const cachedProjects = queryClient.getQueryData(['focusos-projects', user.id]) as any[] | undefined;

      if (cachedMeetings && !projectId) {
        setMeetings(
          cachedMeetings.map((m: any) => ({
            ...m,
            action_items: Array.isArray(m.action_items) ? m.action_items : [],
            processing_status: m.processing_status || 'done',
            processing_error: m.processing_error || null,
            transcript_segments: m.transcript_segments ?? null,
          }))
        );
        setLoading(false);
        // Cached list painted instantly; refresh it quietly behind the render. Within
        // staleTime the fetchQuery serves cache (zero network); past it this refetches
        // so a long-lived (60-min gcTime) entry can never show old meetings for long.
        fetchMeetings({ quiet: true });
      } else {
        fetchMeetings();
      }

      if (cachedProjects) {
        setProjects(cachedProjects.map((p: any) => ({ id: p.id, name: p.name, color: p.color })));
      } else {
        fetchProjects();
      }

      checkOrphanedSessions();
      fetchMeetingSharingInfo();
    }
  }, [user, projectId]);

  const fetchMeetingSharingInfo = async () => {
    if (!user) return;
    try {
      // Only receiver-side accepted meeting shares should appear on this page
      const { data: sharedItems } = await (supabase as any)
        .from('focusos_shared_items')
        .select('recipient_task_id, sender_email, item_title, created_at, updated_at')
        .eq('item_type', 'meeting')
        .eq('recipient_user_id', user.id)
        .eq('status', 'accepted');

      if (!sharedItems || sharedItems.length === 0) {
        setMeetingSharingMap({});
        return;
      }

      // Resolve sender names
      const senderEmails = [...new Set(sharedItems.map((item: any) => item.sender_email).filter(Boolean))];
      const { data: profiles } = await (supabase as any)
        .from('focusos_profiles')
        .select('user_email, first_name, last_name')
        .in('user_email', senderEmails);

      const profileMap: Record<string, string> = {};
      (profiles || []).forEach((p: any) => {
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.user_email;
        if (p.user_email) profileMap[p.user_email] = name;
      });

      // Get receiver meetings for fallback matching (legacy rows without recipient_task_id)
      const { data: receiverMeetings } = await (supabase as any)
        .from('focusos_meetings')
        .select('id, title, created_at')
        .eq('user_id', user.id);

      const map: Record<string, { name: string }> = {};
      const usedMeetingIds = new Set<string>();

      // Primary mapping: direct by cloned meeting id saved in recipient_task_id
      sharedItems.forEach((item: any) => {
        if (!item.recipient_task_id) return;
        const senderName = profileMap[item.sender_email] || item.sender_email;
        map[item.recipient_task_id] = { name: senderName };
        usedMeetingIds.add(item.recipient_task_id);
      });

      // Fallback mapping: legacy accepted shares where recipient_task_id is null
      const legacyShares = sharedItems.filter((item: any) => !item.recipient_task_id && item.item_title);
      const meetingCandidatesByTitle: Record<string, Array<{ id: string; created_at: string }>> = {};

      (receiverMeetings || []).forEach((meeting: any) => {
        if (!meeting.title) return;
        if (!meetingCandidatesByTitle[meeting.title]) meetingCandidatesByTitle[meeting.title] = [];
        meetingCandidatesByTitle[meeting.title].push({ id: meeting.id, created_at: meeting.created_at });
      });

      Object.values(meetingCandidatesByTitle).forEach((list) => {
        list.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      });

      legacyShares.forEach((item: any) => {
        const candidates = (meetingCandidatesByTitle[item.item_title] || []).filter((m) => !usedMeetingIds.has(m.id));
        if (candidates.length === 0) return;

        const referenceTime = new Date(item.created_at).getTime();
        let bestMatch: { id: string; diff: number } | null = null;

        candidates.forEach((candidate) => {
          const diff = Math.abs(new Date(candidate.created_at).getTime() - referenceTime);
          if (!bestMatch || diff < bestMatch.diff) {
            bestMatch = { id: candidate.id, diff };
          }
        });

        // Safety window to avoid incorrect title-only matches
        const MAX_MATCH_WINDOW_MS = 10 * 60 * 1000;
        if (bestMatch && bestMatch.diff <= MAX_MATCH_WINDOW_MS) {
          const senderName = profileMap[item.sender_email] || item.sender_email;
          map[bestMatch.id] = { name: senderName };
          usedMeetingIds.add(bestMatch.id);
        }
      });

      setMeetingSharingMap(map);
    } catch (err) {
      console.error('Error fetching meeting sharing info:', err);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (chunkUploadIntervalRef.current) clearInterval(chunkUploadIntervalRef.current);
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // Polling for async processing
  useEffect(() => {
    if (!processingMeetingId) return;

    const poll = async () => {
      const read = (withSegments: boolean) =>
        (supabase as any)
          .from('focusos_meetings')
          .select(
            withSegments
              ? 'processing_status, processing_error, transcript_segments'
              : 'processing_status, processing_error',
          )
          .eq('id', processingMeetingId)
          .single();

      let { data, error } = await read(!noSegmentsColumnRef.current);

      // Pre-migration backend tolerance: the column is not there yet, so re-ask the
      // same question without it and carry on with no segment counts.
      if (
        error &&
        !noSegmentsColumnRef.current &&
        (error.code === '42703' ||
          String(error.message ?? '').includes('transcript_segments'))
      ) {
        noSegmentsColumnRef.current = true;
        ({ data, error } = await read(false));
      }

      if (error || !data) return;

      const status = (data as any).processing_status as string;
      const procError = (data as any).processing_error as string | null;

      setProcessingStatus(status);
      // Segment ledger -> "Transcribing 3/8". Null whenever the worker has not
      // planned the run yet, which is also what clears the count on the way out
      // of 'transcribing'.
      setProcessingProgress(segmentProgress((data as any).transcript_segments));

      if (status === 'done') {
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = null;
        toast.success('Meeting processed successfully!');
        navigate(`/meetings/${processingMeetingId}`);
        setProcessingMeetingId(null);
        setProcessingProgress(null);
        setRecordingState('idle');
      } else if (status === 'error') {
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = null;
        toast.error(`Processing failed: ${procError || 'Unknown error'}`);
        setProcessingMeetingId(null);
        setProcessingProgress(null);
        setRecordingState('idle');
        fetchMeetings({ fresh: true });
      }
    };

    pollingRef.current = setInterval(poll, 5000);
    // Initial poll
    poll();

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [processingMeetingId, navigate]);

  // Route through the shared projects cache so an /app <-> /meetings switch within
  // staleTime serves from cache instead of re-hitting the network. The shared fetcher
  // returns full own+shared rows; map to the id/name/color shape this page uses.
  const fetchProjects = async () => {
    if (!user) return;
    try {
      const rows = await fetchProjectsShared(queryClient, user.id);
      setProjects(rows.map((p: any) => ({ id: p.id, name: p.name, color: p.color })));
    } catch (error) {
      console.error('[Meetings] fetchProjects failed:', error);
    }
  };

  const checkOrphanedSessions = async () => {
    try {
      const { data: sessions } = await (supabase as any)
        .from('focusos_recording_sessions')
        .select('id, chunk_count, created_at, gcs_folder_path, mime_type, status')
        .in('status', ['processing', 'recording'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (sessions && sessions.length > 0) {
        const session = sessions[0];
        // Only show recovery if session has chunks and is older than 2 minutes
        const ageMs = Date.now() - new Date(session.created_at).getTime();
        if (session.chunk_count > 0 && ageMs > 120000) {
          setOrphanedSession({
            id: session.id,
            chunkCount: session.chunk_count,
            createdAt: session.created_at,
            gcsFolder: session.gcs_folder_path,
            mimeType: session.mime_type,
          });
        }
      }
    } catch (err) {
      console.error('Error checking orphaned sessions:', err);
    }
  };

  const recoverOrphanedSession = async () => {
    if (!orphanedSession) return;
    setRecoveringSession(true);
    toast.info('Recovering your recording...');

    try {
      const validParticipants = participantsRef.current.filter(p => p.name.trim());

      const { data, error } = await supabase.functions.invoke('focusos-process-meeting', {
        body: {
          sessionId: orphanedSession.id,
          mimeType: orphanedSession.mimeType.split(';')[0],
          projectId: projectId || null,
          title: meetingNameRef.current.trim() || `Recovered Meeting ${new Date(orphanedSession.createdAt).toLocaleDateString()} ${new Date(orphanedSession.createdAt).toLocaleTimeString()}`,
          durationSeconds: orphanedSession.chunkCount * 30, // approximate
          participants: validParticipants,
        },
      });

      if (error) throw error;

      setOrphanedSession(null);

      if (data.processing_status && data.processing_status !== 'done') {
        setProcessingMeetingId(data.id);
        setProcessingStatus(data.processing_status);
        setRecordingState('processing');
        triggerTranscription(data);
      } else {
        toast.success('Meeting recovered successfully!');
        navigate(`/meetings/${data.id}`);
      }
    } catch (err) {
      console.error('Recovery error:', err);
      toast.error('Failed to recover recording. Please try again.');
    } finally {
      setRecoveringSession(false);
    }
  };

  const dismissOrphanedSession = async () => {
    if (!orphanedSession) return;
    // Mark the session as failed so it won't show again
      await (supabase as any)
        .from('focusos_recording_sessions')
        .update({ status: 'failed' })
        .eq('id', orphanedSession.id);
    setOrphanedSession(null);
  };

  // Map raw meeting rows into state and, if any are still processing, arm the stuck-meeting
  // poller. Shared by the cached (unfiltered) and the direct (project-filtered) read paths.
  const applyMeetings = (data: any[] | null | undefined) => {
    if (!data) return;
    setMeetings(
      data.map(m => ({
        ...m,
        action_items: Array.isArray(m.action_items) ? m.action_items : [],
        processing_status: (m as any).processing_status || 'done',
        processing_error: (m as any).processing_error || null,
        // Kept explicitly (select('*') returns it) so an in-flight row's card pill
        // can count segments without waiting for the single-row poll.
        transcript_segments: (m as any).transcript_segments ?? null,
      }))
    );

    // Safety net: if any meetings are still in-flight, ping the poller
    // so it picks back up if its chain ever died.
    const inFlight = data.some((m: any) =>
      m.processing_status === 'transcribing' || m.processing_status === 'summarizing'
    );
    if (inFlight) {
      supabase.functions
        .invoke('focusos-poll-stuck-meetings', { body: { chainCount: 0 } })
        .catch((e) => console.warn('arm-on-load poller invoke failed:', e?.message));
    }
  };

  const fetchMeetings = async (opts?: { fresh?: boolean; quiet?: boolean }) => {
    // quiet: background refresh behind an already-rendered cached list — never
    // flip the skeleton back on.
    if (!opts?.quiet) setLoading(true);

    // A project-filtered view is a strict subset of the full list, so it is read directly
    // and never cached under the shared meetings key (a later unfiltered read would
    // otherwise serve the subset).
    if (projectId) {
      const { data, error } = await (supabase as any)
        .from('focusos_meetings')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (!error) applyMeetings(data);
      setLoading(false);
      return;
    }

    if (!user) {
      setLoading(false);
      return;
    }

    try {
      // Single-flight through the shared cache: within staleTime this serves the cached rows
      // with no network (the /app <-> /meetings visit path); `fresh` forces a refetch for the
      // post-mutation callers (processing-error, delete) that must not read the stale snapshot.
      const data = await queryClient.fetchQuery({
        queryKey: appDataKeys.meetings(user.id),
        queryFn: async () => {
          const { data, error } = await (supabase as any)
            .from('focusos_meetings')
            .select('*')
            .order('created_at', { ascending: false });
          if (error) throw error;
          return data || [];
        },
        staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
        gcTime: APP_DATA_GC_TIME,
      });
      applyMeetings(data);
    } catch (err) {
      console.error('[Meetings] fetchMeetings failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const hrs = Math.floor(mins / 60);
    const secs = seconds % 60;
    if (hrs > 0) return `${hrs}h ${mins % 60}m`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  /* ─── Chunk upload helper ──────────────────────────────── */

  const flushChunksToGcs = useCallback(async () => {
    if (isUploadingChunkRef.current || chunksRef.current.length === 0 || !sessionIdRef.current) return;
    isUploadingChunkRef.current = true;

    try {
      const blob = new Blob(chunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
      chunksRef.current = [];

      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      const batchSize = 8192;
      for (let i = 0; i < uint8Array.length; i += batchSize) {
        const slice = uint8Array.subarray(i, i + batchSize);
        binary += String.fromCharCode(...slice);
      }
      const audioBase64 = btoa(binary);

      const currentIndex = chunkIndexRef.current;
      chunkIndexRef.current += 1;

      const { error } = await supabase.functions.invoke('focusos-upload-audio-chunk', {
        body: { sessionId: sessionIdRef.current, chunkIndex: currentIndex, audioBase64 },
      });

      if (error) {
        console.error(`Chunk ${currentIndex} upload failed:`, error);
      } else {
        console.log(`Chunk ${currentIndex} uploaded (${uint8Array.length} bytes)`);
      }
    } catch (err) {
      console.error('Chunk flush error:', err);
    } finally {
      isUploadingChunkRef.current = false;
    }
  }, []);

  /* ─── Recording ────────────────────────────────────────── */

  const handleStartRecording = useCallback(async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          sampleRate: 44100,
        },
      });

      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

      const { data: sessionData, error: sessionError } = await supabase.functions.invoke('focusos-start-recording-session', {
        body: { mimeType: mimeType.split(';')[0] },
      });

      if (sessionError || !sessionData?.sessionId) {
        throw new Error('Failed to start recording session');
      }

      sessionIdRef.current = sessionData.sessionId;
      chunkIndexRef.current = 0;
      console.log('Recording session started:', sessionData.sessionId);

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        if (chunkUploadIntervalRef.current) {
          clearInterval(chunkUploadIntervalRef.current);
          chunkUploadIntervalRef.current = null;
        }

        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;

        await flushChunksToGcs();

        await processSessionMeeting(mimeType);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000);

      setRecordingState('recording');
      setRecordingSeconds(0);
      setIsPaused(false);

      chunkUploadIntervalRef.current = setInterval(() => {
        flushChunksToGcs();
      }, 30000);

      timerRef.current = setInterval(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          setRecordingSeconds(s => s + 1);
        }
      }, 1000);

      toast.success('Recording started');
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        toast.error('Microphone access denied. Check browser permissions.');
      } else {
        toast.error('Failed to start recording. Check your microphone.');
        console.error('Recording error:', error);
      }
    }
  }, [flushChunksToGcs]);

  const handlePauseRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      flushChunksToGcs();
    }
  }, [flushChunksToGcs]);

  const handleResumeRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
    }
  }, []);

  const handleStopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsPaused(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const processSessionMeeting = async (mimeType: string) => {
    setRecordingState('processing');
    setProcessingStatus('uploading');
    toast.info('Uploading and processing your meeting...');

    try {
      const validParticipants = participantsRef.current.filter(p => p.name.trim());

      const { data, error } = await supabase.functions.invoke('focusos-process-meeting', {
        body: {
          sessionId: sessionIdRef.current,
          mimeType: mimeType.split(';')[0],
          projectId: projectId || null,
          title: meetingNameRef.current.trim() || `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
          durationSeconds: recordingSecondsRef.current,
          participants: validParticipants,
        },
      });

      if (error) throw error;

      sessionIdRef.current = null;

      // Check if this is the new async flow
      if (data.processing_status && data.processing_status !== 'done') {
        // Start polling
        setProcessingMeetingId(data.id);
        setProcessingStatus(data.processing_status);

        // Frontend triggers transcribe-meeting directly (no more fire-and-forget)
        triggerTranscription(data);
      } else {
        // Legacy sync flow - navigate directly
        toast.success('Meeting processed successfully!');
        navigate(`/meetings/${data.id}`);
        setRecordingState('idle');
      }
    } catch (error) {
      console.error('Process meeting error:', error);
      // Save sessionId so we can offer recovery
      if (sessionIdRef.current) {
        failedSessionRef.current = sessionIdRef.current;
        // Re-check for orphaned sessions to show the recovery banner
        checkOrphanedSessions();
      }
      toast.error('Failed to process meeting. Your recording is saved — use the recovery banner to retry.');
      setRecordingState('idle');
    }
  };

  /**
   * Kick the segmented transcriber. Its whole contract is the meeting id: the worker
   * reads the recording path, the participants and the segment plan off the row
   * itself, and ignores every other field. `retry: true` is the only extra — it tells
   * the worker this is a Retry, not a fresh run.
   */
  const triggerTranscription = async (
    meetingData: { id: string },
    opts?: { retry?: boolean },
  ) => {
    try {
      console.log('Frontend triggering transcribe-meeting for:', meetingData.id);
      // Don't await - let it run in background while we poll
      supabase.functions.invoke('focusos-transcribe-meeting', {
        body: opts?.retry
          ? { meetingId: meetingData.id, retry: true }
          : { meetingId: meetingData.id },
      }).catch(err => {
        // This may "fail" due to timeout but the function keeps running server-side
        console.log('transcribe-meeting invoke completed or timed out (expected):', err?.message);
      });
    } catch (err) {
      console.error('Failed to trigger transcription:', err);
    }
  };

  const handleRetryMeeting = async (e: React.MouseEvent, meeting: Meeting) => {
    e.stopPropagation();
    toast.info('Retrying meeting processing...');

    try {
      // Fetch full meeting data for retry
      const { data: meetingData, error } = await (supabase as any)
        .from('focusos_meetings')
        .select('*')
        .eq('id', meeting.id)
        .single();

      if (error || !meetingData) throw new Error('Could not fetch meeting data');

      const recordingGcsPath = (meetingData as any).recording_gcs_path as string;

      // The recording in GCS is the only thing a retry needs. There is no expiring
      // upload handle any more, so a row that still has its audio is ALWAYS retryable.
      if (!recordingGcsPath) {
        toast.error('No recording found for this meeting. Cannot retry.');
        return;
      }

      // Reset status + retry counter so the new transcribe call gets a fresh budget,
      // and PROVE it landed: on 2026-09-09 a Retry left gemini_transcribe_attempts at
      // 4, so the worker refused the run it had just been asked to make. A failed
      // reset means no invoke at all.
      //
      // The proof has to be the STORED ROW. An update().eq() with no .select() writes
      // zero rows for a meeting that has vanished or that RLS filters out, answers 204,
      // and supabase-js reports no error at all - "it worked" was being taken on trust.
      // .select(...).single() brings the written values back in the same round trip.
      const { data: resetRow, error: resetError } = await (supabase as any)
        .from('focusos_meetings')
        .update({
          processing_status: 'transcribing',
          processing_error: null,
          gemini_transcribe_attempts: 0,
        })
        .eq('id', meeting.id)
        .select('processing_status, gemini_transcribe_attempts')
        .single();

      if (
        resetError ||
        !resetRow ||
        resetRow.processing_status !== 'transcribing' ||
        resetRow.gemini_transcribe_attempts !== 0
      ) {
        console.error('Retry reset failed:', resetError ?? resetRow);
        toast.error('Could not reset the meeting for retry');
        return;
      }

      setProcessingMeetingId(meeting.id);
      setProcessingStatus('transcribing');
      setProcessingProgress(null);
      setRecordingState('processing');

      triggerTranscription({ id: meeting.id }, { retry: true });
    } catch (err) {
      console.error('Retry error:', err);
      toast.error('Failed to retry processing.');
    }
  };

  const currentProject = projects.find(p => p.id === projectId);

  const handleDeleteMeeting = async (deleteTasks: boolean) => {
    if (!meetingToDelete) return;
    setDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke('focusos-delete-meeting', {
        body: { meetingId: meetingToDelete, deleteTasks },
      });
      if (error) throw error;
      toast.success('Meeting deleted');
      fetchMeetings({ fresh: true });
    } catch (err) {
      console.error('Delete error:', err);
      toast.error('Failed to delete meeting');
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
      setMeetingToDelete(null);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const processingInfo = PROCESSING_LABELS[processingStatus] || PROCESSING_LABELS.uploading;
  // "Transcribing 3/8" the moment the worker has a segment plan, the count-less
  // label until then. Every other status keeps its own wording.
  const processingBannerLabel =
    processingStatus === 'transcribing' && processingProgress
      ? `Transcribing ${processingProgress.done}/${processingProgress.total}`
      : processingInfo.label;

  return (
    <>
    <div className="min-h-screen bg-background pb-20">
      {/* Header — floating glass pill (lg-pagehead) */}
      <div className="sticky top-0 z-10 lg-pagehead" data-meetings-tour-step="page">
        <div className="max-w-4xl mx-auto lg-gutter py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/app')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold">Meetings</h1>
            {currentProject && (
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Folder className="h-3.5 w-3.5" style={{ color: currentProject.color }} />
                <span>{currentProject.name}</span>
              </div>
            )}
          </div>
          {recordingState === 'idle' && !showParticipants && (
            <Button className="gap-2" onClick={() => setShowParticipants(true)} data-meetings-tour-step="new-meeting">
              <Plus className="h-4 w-4" />
              New Meeting
            </Button>
          )}
          {recordingState === 'idle' && showParticipants && (
            <Button variant="ghost" size="sm" onClick={() => setShowParticipants(false)}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Participant Setup — floating glass card, same material as the sidebar.
          Persistently mounted + grid-rows reveal: the frost layer is born once
          at page mount, never dies (white-flash law). data-state derives from
          state during render; inert + pointer-events keep it untabbable closed. */}
      <div
        className="lg-reveal max-w-4xl mx-auto lg-gutter w-full"
        data-state={showParticipants && recordingState === 'idle' ? 'open' : 'closed'}
        aria-hidden={!(showParticipants && recordingState === 'idle')}
        {...(showParticipants && recordingState === 'idle' ? {} : ({ inert: '' } as Record<string, string>))}
      >
        <div className="lg-reveal-clip">
        <div className="lg-reveal-content">
          <div className="lg-glasscard px-5 py-4 space-y-3 mb-1">
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Meeting Name
              </h3>
              <Input
                placeholder="Enter meeting name (required)"
                value={meetingName}
                onChange={(e) => setMeetingName(e.target.value)}
                className="max-w-md"
              />
            </div>
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Meeting Participants
            </h3>
            {participants.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder={`Name ${i + 1}`}
                  value={p.name}
                  onChange={(e) => {
                    const updated = [...participants];
                    updated[i] = { ...updated[i], name: e.target.value };
                    setParticipants(updated);
                  }}
                  className="flex-1"
                />
                <Input
                  placeholder="Email (optional)"
                  type="email"
                  value={p.email}
                  onChange={(e) => {
                    const updated = [...participants];
                    updated[i] = { ...updated[i], email: e.target.value };
                    setParticipants(updated);
                  }}
                  className="flex-1"
                />
                {participants.length > 2 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => setParticipants(participants.filter((_, j) => j !== i))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => setParticipants([...participants, { name: '', email: '' }])}
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add Participant
              </Button>
              <div className="flex-1" />
              <Button
                className="gap-2"
                onClick={() => {
                  if (!meetingName.trim()) {
                    toast.error('Please enter a meeting name');
                    return;
                  }
                  setShowParticipants(false);
                  handleStartRecording();
                }}
              >
                <Mic className="h-4 w-4" />
                Start Recording
              </Button>
            </div>
          </div>
        </div>
        </div>
      </div>

      {recordingState === 'recording' && (
        <div className={`lg-banner-in border-b ${isPaused ? 'bg-amber-500/10 border-amber-500/30' : 'bg-destructive/10 border-destructive/30'}`}>
          <div className="max-w-4xl mx-auto lg-gutter py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                {isPaused ? (
                  <Pause className="h-6 w-6 text-amber-500" />
                ) : (
                  <>
                    <Mic className="h-6 w-6 text-destructive" />
                    <span className="absolute -top-1 -right-1 h-3 w-3 bg-destructive rounded-full animate-pulse" />
                  </>
                )}
              </div>
              <div>
                <p className={`font-semibold ${isPaused ? 'text-amber-500' : 'text-destructive'}`}>
                  {isPaused ? 'Paused' : 'Recording...'}
                </p>
                <p className="text-sm text-muted-foreground font-mono">
                  {formatDuration(recordingSeconds)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isPaused ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-amber-500/50 text-amber-500 hover:bg-amber-500/10"
                  onClick={handleResumeRecording}
                >
                  <Play className="h-4 w-4" />
                  Resume
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={handlePauseRecording}
                >
                  <Pause className="h-4 w-4" />
                  Pause
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                className="gap-2"
                onClick={handleStopRecording}
              >
                <Square className="h-4 w-4" />
                Stop
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Processing Banner with Progress */}
      {recordingState === 'processing' && (
        <div className="lg-banner-in bg-primary/10 border-b border-primary/30">
          <div className="max-w-4xl mx-auto lg-gutter py-6">
            <div className="flex items-center gap-3 mb-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary shrink-0" />
              <div className="flex-1">
                <p className="font-semibold" data-processing-banner-label>{processingBannerLabel}</p>
                <p className="text-sm text-muted-foreground">
                  This may take a few minutes for long recordings
                </p>
              </div>
            </div>
            {processingStatus !== 'error' && (
              <Progress value={processingInfo.progress} className="h-2" />
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="max-w-4xl mx-auto lg-gutter pb-6">
        {/* Orphaned session recovery banner */}
        {orphanedSession && recordingState === 'idle' && (
          <Card className="mb-4 border-amber-500/50 bg-amber-500/10">
            <div className="p-4 flex items-center justify-between gap-4">
              <div className="flex-1">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 text-amber-500" />
                  Unprocessed Recording Found
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  A {orphanedSession.chunkCount * 30}s recording from {new Date(orphanedSession.createdAt).toLocaleString()} wasn't fully processed. Your audio is safe.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={dismissOrphanedSession}
                  disabled={recoveringSession}
                >
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  className="gap-1"
                  onClick={recoverOrphanedSession}
                  disabled={recoveringSession}
                >
                  {recoveringSession ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Recover
                </Button>
              </div>
            </div>
          </Card>
        )}
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : meetings.length === 0 && recordingState === 'idle' ? (
          <div className="text-center py-20" data-meetings-tour-step="list">
            <Mic className="h-12 w-12 mx-auto text-muted-foreground/40 mb-4" />
            <h2 className="text-lg font-semibold mb-1">No meetings yet</h2>
            <p className="text-muted-foreground text-sm mb-6">
              Record a meeting to get AI-powered transcription, summaries, and action items.
            </p>
            <Button className="gap-2" onClick={handleStartRecording}>
              <Mic className="h-4 w-4" />
              Record Your First Meeting
            </Button>
          </div>
        ) : (
          <div className="space-y-3" data-meetings-tour-step="list">
            {meetings.map(meeting => {
              const project = projects.find(p => p.id === meeting.project_id);
              const updatedAt = new Date(meeting.updated_at || meeting.created_at).getTime();
              // Only mark "Failed" when the backend has explicitly set status to error.
              // Stuck rows (no recent update) stay as "Processing" — the poller will retry
              // up to 3 times before flipping the status to error.
              const hasError = meeting.processing_status === 'error';
              const isProcessing =
                !!meeting.processing_status &&
                meeting.processing_status !== 'done' &&
                meeting.processing_status !== 'error';
              const minutesSinceUpdate = Math.floor((Date.now() - updatedAt) / 60000);
              const isLong = isProcessing && minutesSinceUpdate >= 2;
              // The row's own segment ledger, so an in-flight card counts progress
              // without the single-row poll (which only follows ONE meeting).
              const rowProgress = segmentProgress(meeting.transcript_segments);
              const processingLabel =
                meeting.processing_status === 'summarizing'
                  ? 'Summarizing'
                  : meeting.processing_status === 'transcribing'
                    ? rowProgress
                      ? `Transcribing ${rowProgress.done}/${rowProgress.total}`
                      : (isLong ? `Transcribing (${minutesSinceUpdate}m)` : 'Transcribing...')
                    : 'Processing';
              return (
                <Card
                  key={meeting.id}
                  className={`cursor-pointer hover:border-primary/30 transition-colors ${isProcessing ? 'opacity-70' : ''} ${hasError ? 'border-destructive/30' : ''}`}
                  onClick={() => {
                    if (isProcessing) {
                      toast.info('This meeting is still being processed...');
                      return;
                    }
                    navigate(`/meetings/${meeting.id}`);
                  }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold truncate">{meeting.title}</h3>
                          {isProcessing && (
                            <Badge
                              variant="secondary"
                              data-processing-pill
                              className={`text-xs shrink-0 gap-1 ${isLong ? 'bg-amber-500/15 text-amber-600 border-amber-500/30' : ''}`}
                              title={isLong ? 'Transcription is taking longer than usual. Will auto-retry up to 3 times.' : undefined}
                            >
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {processingLabel}
                            </Badge>
                          )}
                          {hasError && (
                            <Badge
                              variant="destructive"
                              className="text-xs shrink-0"
                              title={meeting.processing_error || 'Processing failed'}
                            >
                              Failed
                            </Badge>
                          )}
                          {project && (
                            <Badge variant="outline" className="text-xs shrink-0">
                              <Folder className="h-3 w-3 mr-1" style={{ color: project.color }} />
                              {project.name}
                            </Badge>
                          )}
                        </div>
                        {hasError && meeting.processing_error && (
                          <p className="text-sm text-destructive mb-2">{meeting.processing_error}</p>
                        )}
                        {meeting.summary && !isProcessing && (() => {
                          let displaySummary = meeting.summary;
                          try {
                            const parsed = JSON.parse(meeting.summary);
                            if (parsed.overview) displaySummary = parsed.overview;
                          } catch {}
                          return (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                              {displaySummary}
                            </p>
                          );
                        })()}
                        <div className="flex items-center gap-4 text-xs text-muted-foreground">
                          {meeting.duration_seconds > 0 && (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDuration(meeting.duration_seconds)}
                            </span>
                          )}
                          <span>
                            {format(new Date(meeting.created_at), 'MMM d, yyyy · h:mm a')}
                          </span>
                          {meeting.action_items.length > 0 && (
                            <span className="flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              {meeting.action_items.length} action items
                            </span>
                          )}
                        </div>
                        {meetingSharingMap[meeting.id] && (
                          <Badge 
                            variant="outline" 
                            className="bg-purple-600/15 text-purple-400 border-purple-600/30 text-xs inline-flex items-center gap-1 w-fit mt-1"
                          >
                            <Share2 className="h-3 w-3 shrink-0" />
                            <span>Meeting shared by {meetingSharingMap[meeting.id].name}</span>
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0 mt-1">
                        {(hasError || isProcessing) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-primary"
                            onClick={(e) => handleRetryMeeting(e, meeting)}
                            title="Retry processing"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMeetingToDelete(meeting.id);
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Meeting</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the meeting recording, transcript, and all metadata.
              What would you like to do with associated action items/tasks?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            {/* Plain buttons, not AlertDialogAction (either choice keeps the
                dialog's own close path) — given the house pill classes so the
                three-action row matches every other confirm. */}
            <Button
              variant="outline"
              className="lg-btn"
              disabled={deleting}
              onClick={() => handleDeleteMeeting(false)}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Keep Tasks & Delete Meeting
            </Button>
            <Button
              variant="destructive"
              className="lg-btn danger"
              disabled={deleting}
              onClick={() => handleDeleteMeeting(true)}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Everything
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    {/* Radial FAB — hidden behind every modal surface, the Projects drawer
        included (same guard shape as /app: the FAB is not portalled and sits at
        z-100, so without this it paints over, and stays clickable through, an
        open drawer). */}
    {!projectsDrawerOpen && (
      <RecordFAB onBrainDump={() => navigate('/home?braindump=1')} />
    )}
    {user && (
      <BrainDumpLiveDialog
        open={brainDumpOpen}
        onOpenChange={setBrainDumpOpen}
        userId={user.id}
        projects={projects.map(p => ({ id: p.id, name: p.name }))}
        onTasksCreated={(createdRows) => {
          const n = createdRows?.length ?? 0;
          toast.success(n > 0 ? `${n} task${n === 1 ? '' : 's'} added` : 'Tasks added');
        }}
      />
    )}
    <BottomNav onOpenProjectsDrawer={() => setProjectsDrawerOpen((o) => !o)} />

    {/* Projects drawer: PERMANENTLY mounted, closed by default (white-flash
        law). Opens over /meetings; only a pick inside it navigates. */}
    <ProjectsDrawerHost
      open={projectsDrawerOpen}
      onOpenChange={setProjectsDrawerOpen}
      userId={user?.id}
    />
    <MeetingsTour
      isOpen={tourOpen}
      phase="list"
      onComplete={async () => {
        setTourOpen(false);
        hasAutoLaunchedMeetingsTourRef.current = true;
        await markMeetingsTourComplete();
      }}
      onAdvanceToDetail={() => {
        navigate(`/meetings/${DEMO_MEETING_ID}?tour=meetings&phase=detail`);
      }}
    />
    </>
  );
};

export default Meetings;
