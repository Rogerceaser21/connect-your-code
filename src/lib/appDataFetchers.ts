import type { QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Single-flight app-data fetchers. Index, ProjectSidebar, useUserPreferences and
// usePrefetchAppData all route their cold-load reads through these, keyed on the
// shared query keys below, so React Query's fetchQuery/useQuery dedupe concurrent
// callers to ONE request and serve staleTime-fresh cache. Framework-agnostic: plain
// functions taking (client, userId) — no React imports.

export const APP_DATA_STALE_TIME = 5 * 60 * 1000; // 5 min
// How long an UNOBSERVED cache entry survives. Nothing useQuery-observes the shared
// keys (fetchQuery only), so React Query's default 5-min gcTime silently evicted every
// entry mid-session and turned each navigation into a cold start (the 07-24 vanish /
// skeleton family). Data stays correct via realtime patching + the focus/visibility
// resync + {fresh:true} event paths; this only stops the cache from evaporating.
export const APP_DATA_GC_TIME = 60 * 60 * 1000; // 60 min

// Shared cache keys — the single source of truth. Any caller peeking, invalidating
// or refetching this data must key off these, or the dedup silently breaks.
export const appDataKeys = {
  tasks: (userId: string) => ['focusos-all-tasks', userId] as const,
  completedTasks: (userId: string) => ['focusos-completed-tasks', userId] as const,
  projects: (userId: string) => ['focusos-projects', userId] as const,
  preferences: (userId: string) => ['focusos-preferences', userId] as const,
  memberIds: (userId: string) => ['focusos-member-ids', userId] as const,
  taskImages: (userId: string) => ['focusos-task-images', userId] as const,
  meetings: (userId: string) => ['focusos-meetings', userId] as const,
  meetingsList: (userId: string) => ['focusos-meetings-list', userId] as const,
  sharedItems: (userId: string) => ['focusos-shared-items', userId] as const,
  projectInvitations: (userId: string) => ['focusos-project-invitations', userId] as const,
  // Sender's own focusos_shared_items rows (items THIS user shared out, task or
  // project), the source the share-status pill's per-item maps are built from.
  // O3 fix-round (2026-08-23): usePrefetchAppData's prefetch, Index's warm-path
  // peek, Index's fetchSenderSharedItems, and Home's own useQuery all shared this
  // dataset under TWO different keys (this one for the raw prefetch, plus Home's
  // own `['focusos-sender-shared', userId]` for a pre-built map), so Home mounted
  // two byte-identical selects, and a share on one surface never invalidated the
  // other's cache. Every caller now keys off this single entry.
  senderSharedItems: (userId: string) => ['focusos-sender-shared-items', userId] as const,
};

// Slim projection for the task-list load path: every column transformDbTask (Index.tsx)
// reads, EXCLUDING `images`. Legacy rows hold inline base64 data URLs in `images`, which
// bloats a full select to ~21.5 MB / 7.3s for large accounts; the slim list is ~241 KB.
// `created_at` is not read by transformDbTask but IS required so mergeByIdDesc can order
// the merged own+shared rows. Images are hydrated separately after first paint (see the
// deferred hydration effect in Index.tsx).
export const TASK_LIST_COLUMNS =
  'id,title,description,priority,status,start_date,end_date,due_date,' +
  'timer_total_seconds,timer_is_running,timer_start_time,project_id,sort_order,' +
  'completed_by_email,assigned_to_email,change_request_message,' +
  'google_calendar_event_id,created_at';

// The raw-row keys the task-list caches hold (TASK_LIST_COLUMNS as an array).
export const TASK_LIST_COLUMN_KEYS = TASK_LIST_COLUMNS.split(',');

// Project a full realtime `payload.new` row down to exactly the slim task-list keys. The
// caches under appDataKeys.tasks / .completedTasks hold this slim shape (no `images`);
// realtime sends the whole row, so a realtime patch must slim it or the heavy inline-base64
// `images` column would leak back into the hot task-list cache the slim load exists to avoid.
export function slimTaskRow(raw: any): any {
  const out: any = {};
  for (const k of TASK_LIST_COLUMN_KEYS) out[k] = raw[k];
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Backoff on ERROR (cold-start auth races on mobile Safari), and — for own-data —
// extra backoff on empty-SUCCESS (a tokenless RLS read succeeds with 0 rows).
const ERROR_RETRY_DELAYS = [0, 300, 800, 1500];
const EMPTY_RETRY_DELAYS = [500, 1500];

async function runWithErrorRetry<T>(
  run: () => Promise<{ data: T | null; error: any }>,
): Promise<{ data: T | null; error: any }> {
  let res: { data: T | null; error: any } = { data: null, error: null };
  for (let i = 0; i < ERROR_RETRY_DELAYS.length; i++) {
    if (ERROR_RETRY_DELAYS[i] > 0) await sleep(ERROR_RETRY_DELAYS[i]);
    res = await run();
    if (!res.error) break;
  }
  return res;
}

// Own-data reads drive the "did this account load" decision. Return null only on a
// persistent error (caller throws → query stays retryable). On success, retry a couple
// of times when 0 rows come back so a transient tokenless-RLS empty is not mistaken for
// a genuinely empty account — after the retries an empty set is accepted as truth.
async function fetchOwnRows(
  run: () => Promise<{ data: any[] | null; error: any }>,
): Promise<any[] | null> {
  let res = await runWithErrorRetry<any[]>(run);
  if (res.error) return null;
  let rows = res.data || [];
  for (let i = 0; i < EMPTY_RETRY_DELAYS.length && rows.length === 0; i++) {
    await sleep(EMPTY_RETRY_DELAYS[i]);
    res = await runWithErrorRetry<any[]>(run);
    if (res.error) break; // keep the earlier success ([]) rather than failing the load
    rows = res.data || [];
  }
  return rows;
}

// Shared (accepted-member) reads are best-effort: a failure must never hide the user's
// own rows, so an error degrades to [] rather than throwing.
async function fetchSharedRows(
  run: () => Promise<{ data: any[] | null; error: any }>,
): Promise<any[]> {
  const res = await runWithErrorRetry<any[]>(run);
  if (res.error) return [];
  return res.data || [];
}

// Merge raw DB rows by id (first occurrence wins) and sort created_at desc — the same
// shape/order the previous single unfiltered RLS query returned, now that own and shared
// rows arrive from two separate requests.
export function mergeByIdDesc(rows: any[]): any[] {
  const byId = new Map<string, any>();
  for (const r of rows) {
    if (r && !byId.has(r.id)) byId.set(r.id, r);
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

// Gate the FIRST query of a cold load on a live session. getSession() reads localStorage
// (no network) and resolves instantly once a session exists; before that — the cold-start
// window where onAuthStateChange has not yet restored/refreshed the token — wait briefly
// for INITIAL_SESSION/SIGNED_IN (capped) so queries never fire tokenless and latch empty.
// Memoised: it resolves the moment a session is present and stays resolved, so only the
// genuine first cold call ever waits.
const SESSION_WAIT_CAP_MS = 3000;
let sessionReadyPromise: Promise<void> | null = null;

export function ensureSession(): Promise<void> {
  if (sessionReadyPromise) return sessionReadyPromise;
  sessionReadyPromise = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session) return;
    } catch {
      // fall through to the listener wait
    }
    await new Promise<void>((resolve) => {
      let done = false;
      let sub: { subscription: { unsubscribe: () => void } } | null = null;
      const timer = setTimeout(() => finish(), SESSION_WAIT_CAP_MS);
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sub?.subscription.unsubscribe();
        } catch {
          /* no-op */
        }
        resolve();
      };
      const res = supabase.auth.onAuthStateChange((event, session) => {
        if (session || event === 'INITIAL_SESSION' || event === 'SIGNED_IN') finish();
      });
      sub = res.data;
    });
  })();
  return sessionReadyPromise;
}

// ---- Loaders (the queryFn bodies) — plain async, no cache awareness. ----

async function loadMemberProjectIds(userId: string): Promise<string[]> {
  await ensureSession();
  // A member-id failure degrades to own-only (matches the prior graceful behaviour); it
  // never throws, so the whole task/project load is not sunk by a memberships hiccup.
  const res = await runWithErrorRetry<any[]>(() =>
    (supabase as any)
      .from('focusos_project_members')
      .select('project_id')
      .eq('user_id', userId)
      .eq('status', 'accepted'),
  );
  if (res.error || !res.data) return [];
  return res.data.map((m: any) => m.project_id);
}

// The login/critical-path task load is NON-completed only: status values are
// 'todo' | 'in-progress' | 'completed' (see TaskStatus), so `.neq('status','completed')`
// leaves exactly the open set. Completed rows load lazily off the critical path via
// loadCompletedTasks below, keyed separately so both sets can be cached independently.
async function loadAllTasks(client: QueryClient, userId: string): Promise<any[]> {
  await ensureSession();
  const memberIds = await fetchMemberProjectIds(client, userId);
  const [own, shared] = await Promise.all([
    fetchOwnRows(() =>
      (supabase as any)
        .from('focusos_tasks')
        .select(TASK_LIST_COLUMNS)
        .eq('user_id', userId)
        .neq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1000),
    ),
    memberIds.length
      ? fetchSharedRows(() =>
          (supabase as any)
            .from('focusos_tasks')
            .select(TASK_LIST_COLUMNS)
            .in('project_id', memberIds)
            .neq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(1000),
        )
      : Promise.resolve([] as any[]),
  ]);
  if (own === null) throw new Error('[appDataFetchers] own tasks failed after retries');
  return mergeByIdDesc([...own, ...shared]);
}

// Completed-tasks loader — the lazy other half of loadAllTasks. Same slim projection,
// own + shared, session gate and empty-success retry semantics; only the status
// predicate is inverted (`.eq('status','completed')`). Fetched on demand (deferred
// after first paint, see hydrateCompletedTasks in Index.tsx) and merged into the same
// allTasks state so every Done count / Done tab / chart sees the full set.
async function loadCompletedTasks(client: QueryClient, userId: string): Promise<any[]> {
  await ensureSession();
  const memberIds = await fetchMemberProjectIds(client, userId);
  const [own, shared] = await Promise.all([
    fetchOwnRows(() =>
      (supabase as any)
        .from('focusos_tasks')
        .select(TASK_LIST_COLUMNS)
        .eq('user_id', userId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1000),
    ),
    memberIds.length
      ? fetchSharedRows(() =>
          (supabase as any)
            .from('focusos_tasks')
            .select(TASK_LIST_COLUMNS)
            .in('project_id', memberIds)
            .eq('status', 'completed')
            .order('created_at', { ascending: false })
            .limit(1000),
        )
      : Promise.resolve([] as any[]),
  ]);
  if (own === null) throw new Error('[appDataFetchers] own completed tasks failed after retries');
  return mergeByIdDesc([...own, ...shared]);
}

// Deferred image hydration source — the heavy `images` column for every own + shared
// task that actually HOLDS photos, keyed on its own cache entry so an /app remount
// within staleTime re-applies from cache instead of re-pulling. Returns a map
// id -> images, covering BOTH open and completed tasks so a later completed merge can
// pick images out of it. Own error after retries throws (React Query keeps it
// retryable); a shared-only error degrades to whatever own returned.
//
// TP5: no row cap here at all. Igor's account holds 1,243 tasks, and an unordered
// capped select returned an arbitrary 1,000 of them, so a row carrying photos could
// fall outside the window: after a reload the badge was gone and the next Save wrote
// [] over the stored photos. The read now asks only for rows that hold photos
// (`images` not null and not the empty array), orders by `updated_at` desc so the
// freshest rows arrive first, and pages with `.range()` until a short page ends it.
// Each page goes through runWithErrorRetry, NOT fetchOwnRows: an account with no
// photos legitimately returns 0 rows and must not pay the empty-success retries.
const TASK_IMAGES_PAGE = 500;

// One id + images row as the image read projects it.
type TaskImageRow = { id: string; images: unknown };

// One half of the image read, paged. `own` returns null on a persistent error so the
// caller can throw and keep the React Query entry retryable; `shared` is best effort
// and degrades to whatever was collected before the failure.
async function fetchImagePages(
  build: (from: number) => Promise<{ data: TaskImageRow[] | null; error: unknown }>,
  mode: 'own' | 'shared',
): Promise<TaskImageRow[] | null> {
  const rows: TaskImageRow[] = [];
  for (let from = 0; ; from += TASK_IMAGES_PAGE) {
    const res = await runWithErrorRetry<TaskImageRow[]>(() => build(from));
    if (res.error) return mode === 'own' ? null : rows;
    const page = res.data || [];
    rows.push(...page);
    if (page.length < TASK_IMAGES_PAGE) return rows;
  }
}

async function loadTaskImages(
  client: QueryClient,
  userId: string,
): Promise<Map<string, string[]>> {
  await ensureSession();
  const memberIds = await fetchMemberProjectIds(client, userId);
  // `images` is jsonb, so "has photos" is not-null AND not the empty array.
  const withImages = () =>
    (supabase as any)
      .from('focusos_tasks')
      .select('id, images')
      .not('images', 'is', null)
      .neq('images', '[]');
  const [own, shared] = await Promise.all([
    fetchImagePages(
      (from) =>
        withImages()
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .range(from, from + TASK_IMAGES_PAGE - 1),
      'own',
    ),
    memberIds.length
      ? fetchImagePages(
          (from) =>
            withImages()
              .in('project_id', memberIds)
              .order('updated_at', { ascending: false })
              .range(from, from + TASK_IMAGES_PAGE - 1),
          'shared',
        )
      : Promise.resolve([] as TaskImageRow[]),
  ]);
  if (own === null) throw new Error('[appDataFetchers] task images failed after retries');
  const byId = new Map<string, string[]>();
  for (const row of [...own, ...(shared ?? [])]) {
    if (row && Array.isArray(row.images) && row.images.length > 0) {
      byId.set(row.id, row.images as string[]);
    }
  }
  return byId;
}

// These three sidebar reads use ERROR-retry only (runWithErrorRetry), NOT the empty-
// success retry: an empty result is legitimately common here (no meetings / no shared
// items / no pending invitations), so retrying empty would just add ~2s to the sidebar
// for those users. A persistent error throws so React Query keeps the query retryable.

// Slim meetings list for the sidebar (id, title only). Own-scoped.
async function loadMeetingsList(userId: string): Promise<Array<{ id: string; title: string }>> {
  await ensureSession();
  const res = await runWithErrorRetry<any[]>(() =>
    (supabase as any)
      .from('focusos_meetings')
      .select('id, title')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  );
  if (res.error) throw res.error;
  return (res.data || []).map((m: any) => ({ id: m.id, title: m.title }));
}

// Shared items (sender + recipient rows the RLS policy exposes) in pending/accepted
// state — the sidebar's inbox source. Not user-scoped in the query (RLS scopes it);
// keyed by userId only for cache identity.
async function loadSharedItems(_userId: string): Promise<any[]> {
  await ensureSession();
  const res = await runWithErrorRetry<any[]>(() =>
    (supabase as any)
      .from('focusos_shared_items')
      .select('*')
      .in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: false }),
  );
  if (res.error) throw res.error;
  return res.data || [];
}

// Sender's own shared_items rows (rows where THIS user is the sender), task and
// project alike: the raw dataset behind the share-status pill's per-item maps
// (see src/lib/sharedItems.ts buildSenderSharedMaps for the pure grouping half).
// Exported (not the private loadX convention above) because Home.tsx's own
// useQuery calls this straight as its queryFn, under appDataKeys.senderSharedItems,
// so its request dedupes with the prefetch/Index reads instead of running a
// second, byte-identical select.
export async function fetchSenderSharedItemsRaw(userId: string): Promise<any[]> {
  await ensureSession();
  const res = await runWithErrorRetry<any[]>(() =>
    (supabase as any)
      .from('focusos_shared_items')
      .select('id, item_id, item_type, recipient_email, recipient_user_id, recipient_task_id, status')
      .eq('sender_user_id', userId)
      .in('item_type', ['task', 'project'])
      .neq('status', 'cancelled'),
  );
  if (res.error) throw res.error;
  return res.data || [];
}

// Pending project invitations for this user — the base rows only. The sidebar keeps its
// own name-enrichment (project + inviter profiles) on top, so this loader stays cheap.
async function loadProjectInvitations(userId: string): Promise<any[]> {
  await ensureSession();
  const res = await runWithErrorRetry<any[]>(() =>
    (supabase as any)
      .from('focusos_project_members')
      .select('id, project_id, invited_by, invited_email, role, status')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  );
  if (res.error) throw res.error;
  return res.data || [];
}

// Minimal shape of a raw focusos_projects row, for consumers that want to type
// the loadProjects output narrowly instead of reaching for `any` — loadProjects
// itself stays untyped (bare Supabase select('*') result) since that's the
// existing convention throughout this file.
export interface RawProjectRow {
  id: string;
  name: string;
  color: string;
  is_shared?: boolean;
  user_id?: string;
  archived_at?: string | null;
  parent_project_id?: string | null;
  sort_order?: number | null;
  pinned_at?: string | null;
}

// Single choke point for "is this raw focusos_projects row archived". loadProjects
// keeps returning EVERY row (archived included) — every consumer that needs an
// active-only list filters through this one predicate instead of re-testing
// `archived_at` inline, so the archive feature has exactly one place to change.
export function isProjectArchived(row: { archived_at?: string | null }): boolean {
  return !!row.archived_at;
}

// Companion choke point for "is this raw focusos_projects row a SUB-project".
// Same shape and reasoning as isProjectArchived above: one predicate the raw-row
// consumers share instead of re-testing `parent_project_id` inline. The tree
// itself is built from mapped Project objects, not raw rows — see
// groupProjectTree in src/lib/projectTree.ts.
export function isSubProject(row: { parent_project_id?: string | null }): boolean {
  return !!row.parent_project_id;
}

async function loadProjects(client: QueryClient, userId: string): Promise<any[]> {
  await ensureSession();
  const memberIds = await fetchMemberProjectIds(client, userId);
  const [own, shared] = await Promise.all([
    fetchOwnRows(() =>
      (supabase as any)
        .from('focusos_projects')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ),
    memberIds.length
      ? fetchSharedRows(() =>
          (supabase as any)
            .from('focusos_projects')
            .select('*')
            .in('id', memberIds)
            .order('created_at', { ascending: false }),
        )
      : Promise.resolve([] as any[]),
  ]);
  if (own === null) throw new Error('[appDataFetchers] own projects failed after retries');
  return mergeByIdDesc([...own, ...shared]);
}

export async function loadPreferences(userId: string): Promise<any | null> {
  await ensureSession();
  const res = await runWithErrorRetry<any>(() =>
    (supabase as any)
      .from('focusos_user_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(),
  );
  if (res.error) throw res.error;
  return res.data ?? null; // null = no preferences row yet (see ensureDefaultPreferences)
}

// ---- fetchQuery wrappers (single-flight through the shared cache). ----
// `fresh: true` forces a network refetch (staleTime 0) for the event-driven paths
// (post-mutation / resync / tour) that must not read the 5-min stale snapshot; concurrent
// callers still dedupe. Omit it for the cold load so an in-flight prefetch is REUSED.

interface FetchOpts {
  fresh?: boolean;
}

export function fetchMemberProjectIds(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<string[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.memberIds(userId),
    queryFn: () => loadMemberProjectIds(userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchAllTasks(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.tasks(userId),
    queryFn: () => loadAllTasks(client, userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchCompletedTasks(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.completedTasks(userId),
    queryFn: () => loadCompletedTasks(client, userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchProjects(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.projects(userId),
    queryFn: () => loadProjects(client, userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchTaskImages(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<Map<string, string[]>> {
  return client.fetchQuery({
    queryKey: appDataKeys.taskImages(userId),
    queryFn: () => loadTaskImages(client, userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    // NO extended gcTime here on purpose: this map holds the legacy base64 image
    // payload (~21 MB on data-heavy accounts). Default 5-min GC bounds its memory
    // cost until the image backfill (task 2e1b897b) shrinks it to storage paths.
  });
}

export function fetchMeetingsList(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<Array<{ id: string; title: string }>> {
  return client.fetchQuery({
    queryKey: appDataKeys.meetingsList(userId),
    queryFn: () => loadMeetingsList(userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchSharedItems(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.sharedItems(userId),
    queryFn: () => loadSharedItems(userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function fetchProjectInvitations(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.projectInvitations(userId),
    queryFn: () => loadProjectInvitations(userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

// Single-flight through the shared cache: the fix for refutation A (O3 fix-round,
// 2026-08-23). Every caller (Index's event-driven refetch, the warm-path peek, and
// (via prefetchSenderSharedItems below) usePrefetchAppData) routes through THIS one
// entry, so a `{fresh: true}` refetch on one surface (e.g. Index after a share) is
// visible to every other observer of the same key (e.g. Home's useQuery), and two
// concurrent cold callers collapse to one request instead of two.
export function fetchSenderSharedItemsShared(
  client: QueryClient,
  userId: string,
  opts?: FetchOpts,
): Promise<any[]> {
  return client.fetchQuery({
    queryKey: appDataKeys.senderSharedItems(userId),
    queryFn: () => fetchSenderSharedItemsRaw(userId),
    staleTime: opts?.fresh ? 0 : APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

// ---- prefetch (silent warming for /home → /app). Never throws into the caller. ----

export function prefetchTasks(client: QueryClient, userId: string): Promise<void> {
  return client.prefetchQuery({
    queryKey: appDataKeys.tasks(userId),
    queryFn: () => loadAllTasks(client, userId),
    staleTime: APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function prefetchCompletedTasks(client: QueryClient, userId: string): Promise<void> {
  return client.prefetchQuery({
    queryKey: appDataKeys.completedTasks(userId),
    queryFn: () => loadCompletedTasks(client, userId),
    staleTime: APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function prefetchProjects(client: QueryClient, userId: string): Promise<void> {
  return client.prefetchQuery({
    queryKey: appDataKeys.projects(userId),
    queryFn: () => loadProjects(client, userId),
    staleTime: APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

export function prefetchPreferences(client: QueryClient, userId: string): Promise<void> {
  return client.prefetchQuery({
    queryKey: appDataKeys.preferences(userId),
    queryFn: () => loadPreferences(userId),
    staleTime: APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

// Warms appDataKeys.senderSharedItems ahead of /app; Index's warm-path peek and
// Home's own useQuery both read this same entry (usePrefetchAppData.ts).
export function prefetchSenderSharedItems(client: QueryClient, userId: string): Promise<void> {
  return client.prefetchQuery({
    queryKey: appDataKeys.senderSharedItems(userId),
    queryFn: () => fetchSenderSharedItemsRaw(userId),
    staleTime: APP_DATA_STALE_TIME,
    gcTime: APP_DATA_GC_TIME,
  });
}

// Create the default preferences row exactly once for an account that has none. Guarded
// by a module-level in-flight map so the N concurrent hook instances that all observe
// data === null collapse to a SINGLE insert (a per-user unique constraint would otherwise
// make the losers error). On success the new row is written straight into the shared
// cache, so every observer re-renders with it.
const defaultsInFlight = new Map<string, Promise<any>>();

export function ensureDefaultPreferences(client: QueryClient, userId: string): Promise<any> {
  const existing = defaultsInFlight.get(userId);
  if (existing) return existing;
  const p = (async () => {
    await ensureSession();
    const { data, error } = await (supabase as any)
      .from('focusos_user_preferences')
      .insert({
        user_id: userId,
        default_view: 'today',
        default_display_mode: 'list',
        default_task_filter: 'all',
        default_task_card_view: 'compact',
        default_task_card_view_mobile: 'minimal',
        theme: 'liquid-glass',
        has_completed_onboarding: false,
        has_completed_task_tour: false,
        has_completed_projects_tour: false,
        has_completed_home_tour: false,
        has_completed_meetings_tour: false,
      })
      .select()
      .single();
    if (error) throw error;
    client.setQueryData(appDataKeys.preferences(userId), data);
    return data;
  })();
  defaultsInFlight.set(userId, p);
  // Allow a retry if the insert failed; keep the success cached.
  p.catch(() => {}).finally(() => {
    defaultsInFlight.delete(userId);
  });
  return p;
}
