// Retry re-triggers the SEGMENTED transcriber, and the page counts segments (MT2).
// Cases (b)/(f)/(h) also cover the in-place list-card update on completion (MT8):
// the card used to stay on "Transcribing N/N" until a page refresh because the
// status poll only ever wrote its own standalone banner state, never the
// `meetings` list row the card's pill actually reads. Per Igor's word
// (2026-09-12): on 'done' the app stays on the list, the row flips to its
// finished state in place, and a "Meeting ready" toast appears — no navigation.
//
// What broke: /meetings' Retry button was written for the old one-shot Gemini
// flow. It only fired when the row still carried a `gemini_file_uri`, and told
// the user "Gemini file expired. This meeting needs to be re-recorded." when it
// did not — which, after the 48h Files-API expiry, is every meeting worth
// retrying. The recording itself never expires: it sits in GCS at
// recording_gcs_path. Worse, the reset that clears gemini_transcribe_attempts
// was fired and forgotten, so on 2026-09-09 Igor's Retry left attempts at 4 and
// the worker refused the very run it had just been asked to make.
//
// The rebuilt client (src/pages/Meetings.tsx):
//   - triggerTranscription sends ONLY { meetingId } (+ { retry: true } for Retry);
//     the segmented worker reads everything else off the row.
//   - handleRetryMeeting requires recording_gcs_path, has no gemini_file_uri gate
//     at all, and CHECKS the reset update — a failed reset toasts and invokes
//     nothing, so a stale attempts counter can never reach the worker again.
//   - the status poll reads transcript_segments and both the processing banner and
//     the list-card pill read "Transcribing 3/8" once the worker has a plan,
//     "Transcribing..." until then.
//
// LIVE seed, intercepted server: the meeting row is a REAL zz-prefixed insert on
// the Apple-review demo account (RLS allows it — probed before this spec was
// written), so the Failed card, the reset PATCH and the read-back are all the
// genuine article. Everything that would cost server work or leave state behind
// is route-intercepted: the transcribe-meeting invoke (captured, never run), the
// stuck-meeting poller, and the single-row status poll whose transcript_segments
// payload is this spec's to script. transcript_segments does NOT exist on the
// live table yet (the server half of this wave adds it), which is the other
// reason the progress cases are served from intercepts.
//
// Cases:
//   (b) a Failed card retries: the invoke body deep-equals { meetingId, retry: true },
//       the row really is reset to transcribing / null error / 0 attempts, and once
//       the served poll says 'done' the banner leaves, a "Meeting ready" toast
//       shows, the card's own pill is gone, and the page STAYS on /meetings (MT8);
//   (c) the banner counts: "Transcribing 3/8", then "Transcribing..." once the
//       served ledger goes back to null;
//   (c2) the list-card pill counts the same way, straight off the row applyMeetings
//       mapped, with no poll involved;
//   (d) a reset that fails (403) toasts "Could not reset the meeting for retry",
//       sends NO transcribe-meeting request at all, and never raises the banner;
//   (f) old-backend tolerance: the poll's wide select is answered 400 / 42703 (the
//       pre-migration table, which has no transcript_segments column), and the client
//       re-asks the two-column question, keeps polling THAT, and still reaches 'done'
//       — in place, same as (b): "Meeting ready" toast, pill gone, still /meetings;
//   (g) a reset whose PATCH comes back with no row (204 empty, and again as a 200 [])
//       is refused exactly like the 403: toast, no invoke, no banner, row untouched;
//   (h) an already-transcribing card flips to done from the poll ALONE: the list
//       select is frozen serving the stale "transcribing 3/8" row for the whole
//       case (even the quiet+fresh refetch fired on completion), so the only way
//       the pill can move is the poll's own per-tick patch onto the `meetings` row.
//   (i) a COLD mount (no click, no live recording in this tab) on a row already
//       'transcribing' adopts the client poll on its own: a skeptic-found gap
//       where processingMeetingId was only ever set by a new recording, Retry
//       or orphan recovery IN THE SAME MOUNT, so a page reload or an
//       /app -> /meetings navigation that served an in-flight row from a prior
//       mount's cache had NO client poll and stayed frozen until a hard reload.
// Every case ends in (e): the seeded row is deleted, 0 zz meetings are left, and
// the demo account is back to its 3 projects / 7 tasks baseline with every
// sort_order and pinned_at null.
//
// Cases run one at a time (playwright.config.ts: workers 1, fullyParallel off) —
// the demo account is shared, so two runs at once would stomp each other.
//
// Run: PW_PORT=<a free port, the harness spins its own Vite there> npx playwright test \
//        tests/desktop-meeting-retry.spec.ts --project=desktop-mouse
// (never 8080 — that is Igor's detached preview server.)
import { test, expect, type Page, type APIRequestContext, type Locator, type Route } from '@playwright/test';

const BASE = process.env.WAVE_BASE_URL ?? '';

// Same Apple-review demo account tests/custom-wallpaper.spec.ts signs in with.
const DEMO_EMAIL = 'apple.review@focusos.tech';
const DEMO_PASSWORD = 'FocusOS-Review-2026';

// Same project + publishable key the app ships (src/integrations/supabase/client.ts).
const SUPABASE_URL = 'https://mshlbsgsyzzfxyxramjj.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zaGxic2dzeXp6Znh5eHJhbWpqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDMyNDQ3NDEsImV4cCI6MjA1ODgyMDc0MX0.iyucDGqQuYmJbvejLpCEoSpHP--HsHMw1ZablfMQKmY';

// The demo account's pristine shape, asserted at the end of every case.
const BASELINE_PROJECTS = 3;
const BASELINE_TASKS = 7;

// The seeded row's shape. The error text is the real one the timed-out worker
// writes, and the duration is a 78-minute meeting — the length that made the
// one-shot transcriber time out in the first place.
const SEED_ERROR = 'Transcription timed out after 3 attempts.';
const SEED_GCS_PATH = 'gs://zz-bucket/zz-folder/recording.webm';
const SEED_DURATION = 4671;
// Seeded ALREADY exhausted, so "attempts back to 0" is a real assertion and not a
// value that was 0 all along.
const SEED_ATTEMPTS = 4;

test.use({ actionTimeout: 15000 });

// ---- PostgREST helpers, signed in as the demo account ------------------------

interface Session { token: string; userId: string; }

const restSignIn = async (request: APIRequestContext): Promise<Session> => {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  expect(res.ok(), 'REST sign-in as the demo account must succeed').toBeTruthy();
  const body = await res.json();
  expect(body.access_token, 'REST sign-in must return an access token').toBeTruthy();
  return { token: body.access_token, userId: body.user.id };
};

const restHeaders = (s: Session, extra: Record<string, string> = {}) => ({
  apikey: ANON_KEY,
  Authorization: `Bearer ${s.token}`,
  'Content-Type': 'application/json',
  ...extra,
});

type Row = Record<string, unknown>;

const restSelect = async (
  request: APIRequestContext,
  s: Session,
  path: string,
): Promise<Row[]> => {
  const res = await request.get(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders(s) });
  expect(res.ok(), `select ${path} must succeed (${res.status()})`).toBeTruthy();
  return res.json();
};

/** Insert one meeting row for the demo user and return its id. */
const seedMeeting = async (
  request: APIRequestContext,
  s: Session,
  row: Record<string, unknown>,
): Promise<string> => {
  const res = await request.post(`${SUPABASE_URL}/rest/v1/focusos_meetings`, {
    headers: restHeaders(s, { Prefer: 'return=representation' }),
    data: row,
  });
  expect(res.ok(), `insert into focusos_meetings must succeed (${res.status()})`).toBeTruthy();
  const rows = await res.json();
  expect(rows.length, 'insert must return the new row').toBe(1);
  return rows[0].id as string;
};

/** The stored processing state for one meeting, read straight from Postgres. */
const readMeeting = async (
  request: APIRequestContext,
  s: Session,
  meetingId: string,
): Promise<Row> => {
  const rows = await restSelect(
    request,
    s,
    `focusos_meetings?select=processing_status,processing_error,gemini_transcribe_attempts&id=eq.${meetingId}`,
  );
  expect(rows.length, `meeting ${meetingId} must still exist`).toBe(1);
  return rows[0];
};

/** Exact row count for a table on the demo account (Content-Range, no payload). */
const restCount = async (
  request: APIRequestContext,
  s: Session,
  table: 'focusos_projects' | 'focusos_tasks',
): Promise<number> => {
  const res = await request.get(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: restHeaders(s, { Prefer: 'count=exact' }),
  });
  expect(res.ok(), `counting ${table} must succeed (${res.status()})`).toBeTruthy();
  const range = res.headers()['content-range'] ?? '';
  const total = Number(range.split('/')[1]);
  expect(Number.isFinite(total), `${table} count must parse from ${range}`).toBeTruthy();
  return total;
};

/**
 * (e) Delete every row this run created, PROVE the delete landed, and assert the
 * demo account is back to its pristine shape. Never throws: it returns a list of
 * problems, so a cleanup failure can be reported without swallowing a real test
 * failure.
 */
const cleanup = async (request: APIRequestContext, s: Session): Promise<string[]> => {
  const problems: string[] = [];
  try {
    const del = await request.delete(
      `${SUPABASE_URL}/rest/v1/focusos_meetings?user_id=eq.${s.userId}&title=like.zz-*`,
      { headers: restHeaders(s, { Prefer: 'return=minimal' }) },
    );
    if (!del.ok()) problems.push(`zz meeting delete: HTTP ${del.status()}`);
    const left = await restSelect(request, s, 'focusos_meetings?select=id,title&title=like.zz-*');
    if (left.length) problems.push(`zz meetings left behind: ${left.length}`);

    // Pristine baseline, the same assertion tests/project-order.spec.ts ends on.
    const projects = await restCount(request, s, 'focusos_projects');
    const tasks = await restCount(request, s, 'focusos_tasks');
    if (projects !== BASELINE_PROJECTS) problems.push(`projects: ${projects}, baseline ${BASELINE_PROJECTS}`);
    if (tasks !== BASELINE_TASKS) problems.push(`tasks: ${tasks}, baseline ${BASELINE_TASKS}`);
    const ordered = await restSelect(
      request, s, 'focusos_projects?select=name,sort_order,pinned_at',
    );
    const dirty = ordered.filter((p) => p.sort_order !== null || p.pinned_at !== null);
    if (dirty.length) problems.push(`rows still ordered/pinned: ${dirty.map((p) => String(p.name)).join(', ')}`);
  } catch (e) {
    problems.push(`cleanup threw: ${(e as Error).message}`);
  }
  return problems;
};

// ---- request shapes -----------------------------------------------------------

const TRANSCRIBE_FN = '/functions/v1/focusos-transcribe-meeting';
const POLLER_FN = '/functions/v1/focusos-poll-stuck-meetings';

/**
 * The single-row status poll: `select('processing_status, ...')` on the wire. URL only,
 * so it is deliberately METHOD-BLIND — since the fix round the retry's reset PATCH
 * carries `select=processing_status,gemini_transcribe_attempts` as well, and a route
 * that fulfilled that with a poll payload would break Retry itself. Every status-poll
 * route below therefore goes through routeStatusPoll, which serves GETs and passes
 * everything else straight through.
 */
const isStatusPoll = (url: string) =>
  url.includes('/rest/v1/focusos_meetings') && url.includes('select=processing_status');

/** Serve the status-poll GET; every other focusos_meetings request continues untouched. */
const routeStatusPoll = async (
  page: Page,
  handler: (route: Route) => Promise<void> | void,
): Promise<void> => {
  await page.route(
    (url) => isStatusPoll(url.href),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return handler(route);
    },
  );
};

/** The full list read applyMeetings maps: `select('*').order('created_at', ...)`. */
const isMeetingList = (url: string) =>
  url.includes('/rest/v1/focusos_meetings') && url.includes('select=*');

/** Fulfil a cross-origin PostgREST GET. The ACAO header is what the browser checks. */
const fulfilJson = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

interface Captured { bodies: unknown[]; }

/**
 * Capture every transcribe-meeting invoke instead of running it, and stub the
 * stuck-meeting poller applyMeetings arms for in-flight rows (a real invoke there
 * would hand the server this spec's fake gs:// path).
 */
const stubFunctions = async (page: Page): Promise<Captured> => {
  const captured: Captured = { bodies: [] };
  await page.route(
    (url) => url.href.includes(TRANSCRIBE_FN),
    async (route) => {
      if (route.request().method() === 'POST') {
        captured.bodies.push(route.request().postDataJSON());
      }
      await fulfilJson(route, { ok: true });
    },
  );
  await page.route(
    (url) => url.href.includes(POLLER_FN),
    (route) => fulfilJson(route, { ok: true, chained: 0 }),
  );
  return captured;
};

// ---- the app ------------------------------------------------------------------

const signIn = async (page: Page) => {
  await page.goto(`${BASE}/auth`);
  const panel = page.getByRole('tabpanel');
  await panel.getByLabel(/email/i).fill(DEMO_EMAIL);
  await panel.getByLabel(/password/i).first().fill(DEMO_PASSWORD);
  await panel.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/home', { timeout: 20000 });
};

/** One meeting card in the list, picked by its title. */
const cardFor = (page: Page, title: string): Locator =>
  page.locator('[data-meetings-tour-step="list"] > *').filter({ hasText: title });

const openMeetings = async (page: Page, title: string): Promise<Locator> => {
  await page.goto(`${BASE}/meetings`);
  const card = cardFor(page, title);
  await expect(card).toHaveCount(1, { timeout: 30000 });
  return card;
};

const bannerLabel = (page: Page): Locator => page.locator('[data-processing-banner-label]');
const pillOf = (card: Locator): Locator => card.locator('[data-processing-pill]');

// ---- cases ---------------------------------------------------------------------

test.describe('meeting Retry drives the segmented transcriber (MT2)', () => {
  /**
   * Seed one zz meeting for the demo user, run the body, and ALWAYS hand the
   * account back clean — the body is wrapped so a failing case still cleans up.
   */
  const withSeededMeeting = async (
    request: APIRequestContext,
    body: (ctx: { s: Session; meetingId: string; title: string }) => Promise<void>,
    overrides: Record<string, unknown> = {},
  ) => {
    const s = await restSignIn(request);
    const stamp = Date.now();
    const title = `zz-retry ${stamp}`;
    let bodyError: Error | null = null;
    try {
      const meetingId = await seedMeeting(request, s, {
        user_id: s.userId,
        project_id: null,
        title,
        duration_seconds: SEED_DURATION,
        processing_status: 'error',
        processing_error: SEED_ERROR,
        recording_gcs_path: SEED_GCS_PATH,
        gemini_file_uri: null,
        gemini_transcribe_attempts: SEED_ATTEMPTS,
        ...overrides,
      });
      await body({ s, meetingId, title });
    } catch (e) {
      bodyError = e as Error;
    }
    const problems = await cleanup(request, s);
    if (bodyError) {
      if (problems.length) bodyError.message = `${bodyError.message}\n[cleanup problems] ${problems.join('; ')}`;
      throw bodyError;
    }
    expect(problems, 'cleanup must leave the demo account exactly as it was').toEqual([]);
  };

  test('(b) Retry invokes { meetingId, retry: true } and really resets the row', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withSeededMeeting(request, async ({ s, meetingId, title }) => {
      const captured = await stubFunctions(page);

      // The poll is scripted from here: 'transcribing' while the retry is being proven,
      // then 'done' to watch the card flip in place. summary/duration_seconds only
      // show up once done, matching what the real worker writes.
      let pollStatus = 'transcribing';
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: pollStatus,
        processing_error: null,
        summary: pollStatus === 'done' ? 'zz retried meeting summary' : null,
        duration_seconds: SEED_DURATION,
      }));

      await signIn(page);
      const card = await openMeetings(page, title);

      // (a) the seeded row reaches the page as a Failed card carrying its error.
      await expect(card.getByText('Failed', { exact: true })).toBeVisible();
      await expect(card.getByText(SEED_ERROR)).toBeVisible();

      const retry = card.locator('[title="Retry processing"]');
      await expect(retry).toBeVisible();
      await retry.click();

      // The whole contract of the segmented worker: the meeting id, and the fact
      // that this is a retry. Nothing else — no geminiFileUri, no gcsBucket.
      await expect.poll(() => captured.bodies.length, {
        message: 'Retry must invoke focusos-transcribe-meeting exactly once',
        timeout: 30000,
      }).toBe(1);
      expect(captured.bodies[0]).toEqual({ meetingId, retry: true });

      // ...and the reset that ran BEFORE it landed in Postgres. The 2026-09-09
      // failure was silent, so this is read back from the table, not from the UI.
      await expect.poll(async () => readMeeting(request, s, meetingId), {
        message: 'the reset update must actually land',
        timeout: 20000,
      }).toEqual({
        processing_status: 'transcribing',
        processing_error: null,
        gemini_transcribe_attempts: 0,
      });

      // ...and the banner does not spin for ever: the first poll that reads 'done'
      // flips the card in place — Igor's word, 2026-09-12: no navigation away
      // from the list, a "Meeting ready" toast, the pill just gone (MT8).
      pollStatus = 'done';
      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Meeting ready' }),
      ).toBeVisible({ timeout: 30000 });
      await expect(bannerLabel(page)).toHaveCount(0, { timeout: 10000 });
      await expect(pillOf(card)).toHaveCount(0, { timeout: 10000 });

      // Held: this must still be the list a few seconds later, not a navigation
      // that just hadn't fired yet.
      await page.waitForTimeout(3000);
      await expect(page).toHaveURL(/\/meetings$/);
      await expect(pillOf(card)).toHaveCount(0);
    });
  });

  test('(c) the processing banner counts transcribed segments', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withSeededMeeting(request, async ({ meetingId, title }) => {
      await stubFunctions(page);

      // The ledger this run serves to the status poll. Swapped mid-test, so the
      // banner has to follow the data rather than latch on first read.
      let segments: unknown = { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } };
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: 'transcribing',
        processing_error: null,
        transcript_segments: segments,
      }));

      await signIn(page);
      const card = await openMeetings(page, title);
      await card.locator('[title="Retry processing"]').click();

      // 3 of the 8 planned segments carry text.
      await expect(bannerLabel(page)).toHaveText('Transcribing 3/8', { timeout: 30000 });

      // No plan yet (or not planned at all): the count disappears, the label does
      // not. The poll runs every 5s, so give it a couple of rounds.
      segments = null;
      await expect(bannerLabel(page)).toHaveText('Transcribing...', { timeout: 30000 });
    });
  });

  test('(c2) an in-flight list card counts segments off its own row', async ({ page, request }) => {
    test.setTimeout(120_000);
    // Seeded mid-transcription, so the card renders the processing pill and never
    // the Failed one — this case never touches Retry. The mount-time adoption
    // (case i) does start the single-row poll for this row, and every tick
    // patches the list row from the poll payload, so that poll is served the
    // SAME ledger the list route fabricates below — as the live table would:
    // the DB row and the list row are one row and can never disagree.
    await withSeededMeeting(request, async ({ title }) => {
      await stubFunctions(page);
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: 'transcribing',
        processing_error: null,
        transcript_segments: { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } },
        summary: null,
        duration_seconds: SEED_DURATION,
      }));

      // applyMeetings must carry transcript_segments through onto the mapped row.
      // The rest of the list read stays real; only this run's row is rewritten.
      await page.route(
        (url) => isMeetingList(url.href),
        async (route) => {
          const response = await route.fetch();
          const rows = (await response.json()) as Array<Record<string, unknown>>;
          const patched = Array.isArray(rows)
            ? rows.map((r) => (r.title === title
              ? { ...r, transcript_segments: { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } } }
              : r))
            : rows;
          await route.fulfill({ response, json: patched });
        },
      );

      await signIn(page);
      const card = await openMeetings(page, title);
      await expect(pillOf(card)).toHaveText('Transcribing 3/8', { timeout: 30000 });
    }, { processing_status: 'transcribing', processing_error: null });
  });

  test('(d) a reset that fails toasts and invokes nothing', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withSeededMeeting(request, async ({ s, meetingId, title }) => {
      const captured = await stubFunctions(page);

      // The reset PATCH is refused. Only focusos_meetings PATCHes are touched, so
      // the wallpaper sync's own preferences PATCH still goes through untouched.
      let patchHits = 0;
      await page.route(
        (url) => url.href.includes('/rest/v1/focusos_meetings'),
        async (route) => {
          if (route.request().method() !== 'PATCH') return route.continue();
          patchHits += 1;
          return fulfilJson(route, { message: 'permission denied', code: '42501' }, 403);
        },
      );

      await signIn(page);
      const card = await openMeetings(page, title);
      await card.locator('[title="Retry processing"]').click();

      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Could not reset the meeting for retry' }),
      ).toBeVisible({ timeout: 20000 });
      await expect.poll(() => patchHits, {
        message: 'the reset PATCH must have been attempted',
        timeout: 20000,
      }).toBe(1);

      // A stale attempts counter must never reach the worker: no invoke at all.
      // Sampled across a window — the invoke is fire-and-forget, so a single
      // assertion right after the toast could pass on a broken build.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        expect(captured.bodies, 'no transcribe-meeting invoke after a failed reset').toEqual([]);
        await page.waitForTimeout(250);
      }

      // The page never flipped into its processing state either: no banner, so no
      // spinner left behind for a run that was refused. Positive wait, then absence.
      await page.waitForTimeout(2000);
      await expect(bannerLabel(page)).toHaveCount(0);

      // The row is untouched, error and exhausted counter and all.
      expect(await readMeeting(request, s, meetingId)).toEqual({
        processing_status: 'error',
        processing_error: SEED_ERROR,
        gemini_transcribe_attempts: SEED_ATTEMPTS,
      });
    });
  });

  test('(f) a pre-migration backend (no transcript_segments column) still polls through to done', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withSeededMeeting(request, async ({ meetingId, title }) => {
      const captured = await stubFunctions(page);

      // transcript_segments does NOT exist on the live table yet (the server half of
      // this wave adds it), and PostgREST answers an unknown column with HTTP 400 /
      // code 42703. `if (error || !data) return;` swallowed that, so before the fix
      // round the poll never reached 'done' or 'error': no navigate, no toast, a
      // banner that spins for ever, for Retry / fresh recordings / orphan recovery
      // alike. Here the WIDE select always 400s, so a client that does not downgrade
      // to the two-column question can never pass this case.
      let wideHits = 0;
      let narrowHits = 0;
      let narrowStatus = 'transcribing';
      await routeStatusPoll(page, (route) => {
        if (route.request().url().includes('transcript_segments')) {
          wideHits += 1;
          return fulfilJson(route, {
            code: '42703',
            message: 'column focusos_meetings.transcript_segments does not exist',
            details: null,
            hint: null,
          }, 400);
        }
        narrowHits += 1;
        return fulfilJson(route, {
          processing_status: narrowStatus,
          processing_error: null,
          summary: narrowStatus === 'done' ? 'zz pre-migration summary' : null,
          duration_seconds: SEED_DURATION,
        });
      });

      await signIn(page);
      const card = await openMeetings(page, title);

      // The re-issued poll: the same question with transcript_segments dropped. Armed
      // BEFORE the click, because the downgrade happens inside the very first tick.
      const fallbackPoll = page.waitForRequest(
        (req) => isStatusPoll(req.url())
          && req.method() === 'GET'
          && !req.url().includes('transcript_segments'),
        { timeout: 30000 },
      );
      await card.locator('[title="Retry processing"]').click();
      await fallbackPoll;

      // The retry itself is unaffected by the downgrade.
      await expect.poll(() => captured.bodies.length, {
        message: 'Retry must still invoke focusos-transcribe-meeting exactly once',
        timeout: 30000,
      }).toBe(1);
      expect(captured.bodies[0]).toEqual({ meetingId, retry: true });

      // progress = null on the fallback read, so the count-less label.
      await expect(bannerLabel(page)).toHaveText('Transcribing...', { timeout: 15000 });

      // The ref sticks: later ticks (the poll runs every 5s) ask the narrow question
      // straight away, so the 400 is paid ONCE for the whole mount, not once a tick.
      await expect.poll(() => narrowHits, {
        message: 'the poll must keep running on the narrow select',
        timeout: 30000,
      }).toBeGreaterThanOrEqual(3);
      expect(wideHits, 'the wide select must be tried once and never again').toBe(1);

      // ...and the poll still reaches its exit on the narrow select alone: the
      // card flips in place, same as (b) — no navigation, "Meeting ready" toast,
      // pill gone (MT8).
      narrowStatus = 'done';
      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Meeting ready' }),
      ).toBeVisible({ timeout: 30000 });
      await expect(bannerLabel(page)).toHaveCount(0, { timeout: 10000 });
      await expect(pillOf(card)).toHaveCount(0, { timeout: 10000 });

      await page.waitForTimeout(3000);
      await expect(page).toHaveURL(/\/meetings$/);
      await expect(pillOf(card)).toHaveCount(0);
    });
  });

  test('(g) a reset PATCH that comes back with no row is refused like a failed reset', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withSeededMeeting(request, async ({ s, meetingId, title }) => {
      const captured = await stubFunctions(page);

      // What "no row" actually looks like to supabase-js, read out of
      // @supabase/postgrest-js 2.110.0 (dist/index.mjs, processResponse): the
      // empty-array -> null collapse is gated on `isMaybeSingle`, which ONLY
      // .maybeSingle() sets. So for the .single() this reset uses:
      //   * 204 / empty body -> { data: null, error: null }  <- the true "no row"
      //   * 200 / []         -> { data: [],   error: null }  <- an array, still no error
      // NEITHER carries an error, which is the whole point of the fix: the guard has to
      // read the returned VALUES (processing_status / gemini_transcribe_attempts), not
      // just `error`. Both shapes are exercised below, in that order.
      let patchHits = 0;
      let emptyBody = true;
      await page.route(
        (url) => url.href.includes('/rest/v1/focusos_meetings'),
        async (route) => {
          if (route.request().method() !== 'PATCH') return route.continue();
          patchHits += 1;
          if (emptyBody) {
            return route.fulfill({
              status: 204,
              headers: { 'access-control-allow-origin': '*' },
              body: '',
            });
          }
          return fulfilJson(route, []);
        },
      );

      /** No invoke may fire across a window — the invoke is fire-and-forget. */
      const noInvokeFor = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          expect(captured.bodies, 'no transcribe-meeting invoke after a rowless reset').toEqual([]);
          await page.waitForTimeout(250);
        }
      };

      await signIn(page);
      const card = await openMeetings(page, title);
      const retry = card.locator('[title="Retry processing"]');
      await expect(retry).toBeVisible();

      // Shape 1: 204 with no body.
      await retry.click();
      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Could not reset the meeting for retry' }),
      ).toBeVisible({ timeout: 20000 });
      await expect.poll(() => patchHits, {
        message: 'the reset PATCH must have been attempted',
        timeout: 20000,
      }).toBe(1);
      await noInvokeFor(4000);
      await expect(bannerLabel(page)).toHaveCount(0);

      // Shape 2: 200 with an empty array. Same refusal — asserted on the invoke and
      // the banner rather than the toast, which is already on screen from shape 1.
      emptyBody = false;
      await retry.click();
      await expect.poll(() => patchHits, {
        message: 'the second reset PATCH must have been attempted',
        timeout: 20000,
      }).toBe(2);
      await noInvokeFor(4000);
      await expect(bannerLabel(page)).toHaveCount(0);

      // Nothing reached the table on either shape.
      expect(await readMeeting(request, s, meetingId)).toEqual({
        processing_status: 'error',
        processing_error: SEED_ERROR,
        gemini_transcribe_attempts: SEED_ATTEMPTS,
      });
    });
  });

  test('(h) the list card flips in place from the poll alone, no list refetch involved', async ({ page, request }) => {
    test.setTimeout(120_000);
    // Seeded already mid-transcription, same shape as (c2) — Retry is only the
    // hook this spec uses to make the page start polling THIS meeting id
    // client-side; the row was already 'transcribing' before it is clicked.
    await withSeededMeeting(request, async ({ title }) => {
      await stubFunctions(page);

      const staleSegments = { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } };

      // The list select is FROZEN on this exact stale "3/8" row for the WHOLE
      // case — including the quiet+fresh refetch the app fires right after
      // 'done'. If anything other than the poll's own per-row patch were what
      // flipped the pill, this frozen read would drag it straight back.
      await page.route(
        (url) => isMeetingList(url.href),
        async (route) => {
          const response = await route.fetch();
          const rows = (await response.json()) as Array<Record<string, unknown>>;
          const patched = Array.isArray(rows)
            ? rows.map((r) => (r.title === title
              ? { ...r, processing_status: 'transcribing', processing_error: null, transcript_segments: staleSegments }
              : r))
            : rows;
          await route.fulfill({ response, json: patched });
        },
      );

      let pollStatus = 'transcribing';
      let segments: unknown = staleSegments;
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: pollStatus,
        processing_error: null,
        transcript_segments: segments,
        summary: pollStatus === 'done' ? 'zz poll-only summary' : null,
        duration_seconds: SEED_DURATION,
      }));

      await signIn(page);
      const card = await openMeetings(page, title);
      await expect(pillOf(card)).toHaveText('Transcribing 3/8', { timeout: 30000 });

      // Kick off the client-side poll for this exact row (the reset PATCH lands
      // for real; the frozen list select and the scripted poll above are what
      // the page actually reads back from here).
      await card.locator('[title="Retry processing"]').click();
      await expect(pillOf(card)).toHaveText('Transcribing 3/8', { timeout: 30000 });

      // Drive the SAME meeting straight to done through the poll only.
      segments = {
        total: 8,
        texts: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f', '6': 'g', '7': 'h' },
      };
      pollStatus = 'done';

      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Meeting ready' }),
      ).toBeVisible({ timeout: 30000 });
      await expect(pillOf(card)).toHaveCount(0, { timeout: 10000 });

      // Held: the list select keeps insisting the row is stuck at "transcribing
      // 3/8" underneath — if applyMeetings' plain overwrite were still in play
      // the very next quiet+fresh refetch would drag the pill straight back.
      await page.waitForTimeout(6000);
      await expect(pillOf(card)).toHaveCount(0);
      await expect(page).toHaveURL(/\/meetings$/);
    }, { processing_status: 'transcribing', processing_error: null });
  });

  test('(i) a cold mount adopts the poll for an already-transcribing row, no click needed', async ({ page, request }) => {
    test.setTimeout(120_000);
    // Seeded already mid-transcription — same shape as (c2)/(h) — but this case
    // never touches Retry or any other control that sets processingMeetingId
    // itself. The only trigger allowed is page.goto('/meetings') landing fresh:
    // exactly the "page reload, or an /app -> /meetings mount that reuses a
    // cached list" gap the skeptic found in applyMeetings.
    await withSeededMeeting(request, async ({ title }) => {
      await stubFunctions(page);

      const staleSegments = { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } };

      // The list select stays frozen on this exact stale "3/8" row for the WHOLE
      // case, including the quiet+fresh refetch fired on completion. If the pill
      // ever moves, it can only be the poll's own per-row patch — proving the
      // poll itself was started by the mount, with nothing else in play.
      await page.route(
        (url) => isMeetingList(url.href),
        async (route) => {
          const response = await route.fetch();
          const rows = (await response.json()) as Array<Record<string, unknown>>;
          const patched = Array.isArray(rows)
            ? rows.map((r) => (r.title === title
              ? { ...r, processing_status: 'transcribing', processing_error: null, transcript_segments: staleSegments }
              : r))
            : rows;
          await route.fulfill({ response, json: patched });
        },
      );

      let pollStatus = 'transcribing';
      let segments: unknown = staleSegments;
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: pollStatus,
        processing_error: null,
        transcript_segments: segments,
        summary: pollStatus === 'done' ? 'zz cold-mount summary' : null,
        duration_seconds: SEED_DURATION,
      }));

      // Armed BEFORE the mount: proves the single-row poll fires with no click
      // and no live recording in this tab at all — pure mount-time adoption.
      const firstPoll = page.waitForRequest(
        (req) => isStatusPoll(req.url()) && req.method() === 'GET',
        { timeout: 30000 },
      );

      await signIn(page);
      const card = await openMeetings(page, title);
      await expect(pillOf(card)).toHaveText('Transcribing 3/8', { timeout: 30000 });
      await firstPoll;

      // No control was ever clicked. Drive the SAME meeting straight to done
      // through the poll alone.
      segments = {
        total: 8,
        texts: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f', '6': 'g', '7': 'h' },
      };
      pollStatus = 'done';

      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Meeting ready' }),
      ).toBeVisible({ timeout: 30000 });
      await expect(pillOf(card)).toHaveCount(0, { timeout: 10000 });

      // Held: the frozen list select keeps insisting the row is stuck at
      // "transcribing 3/8" underneath, and the page must still be the list —
      // not a navigation that just hadn't fired yet.
      await page.waitForTimeout(6000);
      await expect(pillOf(card)).toHaveCount(0);
      await expect(page).toHaveURL(/\/meetings$/);
    }, { processing_status: 'transcribing', processing_error: null });
  });

  test('(j) a tab coming back to the foreground polls at once and keeps its in-flight row', async ({ page, request }) => {
    test.setTimeout(120_000);
    // Warm return: a hidden tab's timers crawl, so the client polls the instant
    // visibilityState flips back to 'visible' (Meetings.tsx onVisible). Headless
    // Chromium never really backgrounds a page, so the transition is synthesised:
    // the visibilityState getter is overridden and a GENUINE visibilitychange
    // event is dispatched — the listener cannot tell the difference.
    await withSeededMeeting(request, async ({ title }) => {
      await stubFunctions(page);

      const staleSegments = { total: 8, texts: { '0': 'a', '1': 'b', '2': 'c' } };
      await page.route(
        (url) => isMeetingList(url.href),
        async (route) => {
          const response = await route.fetch();
          const rows = (await response.json()) as Array<Record<string, unknown>>;
          const patched = Array.isArray(rows)
            ? rows.map((r) => (r.title === title
              ? { ...r, processing_status: 'transcribing', processing_error: null, transcript_segments: staleSegments }
              : r))
            : rows;
          await route.fulfill({ response, json: patched });
        },
      );

      let pollStatus = 'transcribing';
      let segments: unknown = staleSegments;
      await routeStatusPoll(page, (route) => fulfilJson(route, {
        processing_status: pollStatus,
        processing_error: null,
        transcript_segments: segments,
        summary: pollStatus === 'done' ? 'zz warm-return summary' : null,
        duration_seconds: SEED_DURATION,
      }));
      const isPollGet = (req: { url(): string; method(): string }) => isStatusPoll(req.url()) && req.method() === 'GET';

      await signIn(page);
      const card = await openMeetings(page, title);
      await expect(pillOf(card)).toHaveText('Transcribing 3/8', { timeout: 30000 });
      await page.waitForRequest(isPollGet, { timeout: 30000 });

      const setVisibility = (state: 'hidden' | 'visible') => page.evaluate((s) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);

      // Go hidden. Nothing that fires on a visibility change may clear the
      // in-flight row: the pill must still be counting when we come back.
      await setVisibility('hidden');
      await page.waitForTimeout(1500);
      await expect(pillOf(card)).toHaveText('Transcribing 3/8');

      // Come back with the row now done. Sync to an interval tick first so the
      // next scheduled poll is ~5 s away: a poll GET inside 1.5 s of the event
      // can only be the catch-up poll, never a coincidental tick.
      segments = {
        total: 8,
        texts: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e', '5': 'f', '6': 'g', '7': 'h' },
      };
      pollStatus = 'done';
      await page.waitForRequest(isPollGet, { timeout: 10000 });
      const catchUp = page.waitForRequest(isPollGet, { timeout: 1500 });
      await setVisibility('visible');
      await catchUp;

      await expect(
        page.locator('[data-sonner-toast]', { hasText: 'Meeting ready' }),
      ).toBeVisible({ timeout: 10000 });
      await expect(pillOf(card)).toHaveCount(0, { timeout: 10000 });
      await expect(page).toHaveURL(/\/meetings$/);
    }, { processing_status: 'transcribing', processing_error: null });
  });
});
