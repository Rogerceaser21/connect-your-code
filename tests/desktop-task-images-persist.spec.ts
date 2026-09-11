// Task IMAGES survive a refetch, and the next Save never wipes them (TP1).
//
// Igor's users lose task photos. Reproduced live on focusos.tech with the demo
// account: attach a photo and create the task -> the card shows the image badge
// "1" and the row really holds one path; fire a window focus -> the badge is
// gone while the row still holds the path; open Edit (the gallery now reads
// 0/8) and press Save Changes without touching images -> the row is written
// back as []. A display bug that turns into DATA LOSS on the next save.
//
// Mechanism: the task list loads through TASK_LIST_COLUMNS (src/lib/
// appDataFetchers.ts), a slim projection WITHOUT `images` (the 2026-07-22 speed
// fix). Images are filled in once, ~1s after first paint, by the deferred
// hydration effect in src/pages/Index.tsx. Every LATER refetch (the focus /
// online / visibilitychange resync, and the >60s warm return) replaced state
// with those slim rows, and transformDbTask turns a MISSING `images` key into
// [] — so the hydrated set was dropped on the floor. EditTaskDialog then seeds
// from task.images ([]), and handleUpdateTask writes images: [] because the
// image pass had already run.
//
// LIVE, not hermetic: the whole point is what a real slim select returns, so
// every read and write here goes to the real backend as the Apple-review demo
// account, the same way tests/project-archive.spec.ts and
// tests/project-rollups.spec.ts do. Rows are zz-prefixed and stamped, cleanup
// deletes them through PostgREST and PROVES the deletes landed, and the run
// ends by asserting the demo account's pristine baseline exactly as
// tests/project-order.spec.ts does: 3 projects, 7 tasks, every sort_order and
// pinned_at null.
//
// The seeded image is a PATH STRING only (`<uid>/zz-persist-<stamp>.png`).
// The badge, the gallery count and the stored array are all the app needs it
// for, so nothing is uploaded and no storage object is created; cleanup still
// sweeps the bucket for that path in case a future change starts uploading.
//
// TP5 is the same data loss reached by a second door: the image read itself was
// capped (`.limit(1000)`, no order, no filter), so on an account with more than
// 1,000 tasks an arbitrary 1,000 came back and a row holding photos could simply
// fall outside the window. The hydration then declared itself done, and the next
// Save Changes wrote [] over the stored photos. The read now asks only for rows
// that hold photos, ordered, and pages until it has them all; and the save writes
// the `images` column only when the pane CHANGED photos, merged against the
// stored row.
//
// Cases:
//   (a) focus resync keeps the badge;
//   (b) after (a), Edit shows (1/8) and Save Changes leaves the row at 1 image;
//   (c) a faked warm return (hidden, +61s, visible) keeps badge and row;
//   (d) removing the image still works: row 0 images, badge gone;
//   (e) a 1,100-task account: the reload's image reads carry no 1,000 cap and
//       return every photo row (201), the badge is back, and Save keeps the photo;
//   (f) with the image read forced empty, Save leaves the stored photos alone, and
//       attaching one adds to them instead of replacing them.
//
// Cases run one at a time (playwright.config.ts: workers 1, fullyParallel off) —
// the demo account is shared, so two runs at once would stomp each other.
//
// Run: PW_PORT=8094 npx playwright test tests/desktop-task-images-persist.spec.ts --project=desktop-mouse
import { test, expect, type Page, type APIRequestContext, type Locator, type Response } from '@playwright/test';

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

const IMAGE_BUCKET = 'focusos-task-images';

// The image read's own signature: `select('id, images')` reaches the wire as this.
const IMAGE_SELECT = 'select=id%2Cimages';

// A valid 1 px PNG, the file case (f) attaches through the pane's file input.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

/** The page-side hooks this spec installs for the faked warm return. */
type Tp1Window = Window & { __tp1SetVisibility?: (next: 'visible' | 'hidden') => void };

const restSelect = async (
  request: APIRequestContext,
  s: Session,
  path: string,
): Promise<Row[]> => {
  const res = await request.get(`${SUPABASE_URL}/rest/v1/${path}`, { headers: restHeaders(s) });
  expect(res.ok(), `select ${path} must succeed (${res.status()})`).toBeTruthy();
  return res.json();
};

const restInsert = async (
  request: APIRequestContext,
  s: Session,
  row: Record<string, unknown>,
): Promise<string> => {
  const res = await request.post(`${SUPABASE_URL}/rest/v1/focusos_tasks`, {
    headers: restHeaders(s, { Prefer: 'return=representation' }),
    data: row,
  });
  expect(res.ok(), `insert into focusos_tasks must succeed (${res.status()})`).toBeTruthy();
  const rows = await res.json();
  expect(rows.length, 'insert must return the new row').toBe(1);
  return rows[0].id as string;
};

/** The stored images array for one task, read straight from Postgres. */
const readImages = async (
  request: APIRequestContext,
  s: Session,
  taskId: string,
): Promise<string[]> => {
  const rows = await restSelect(request, s, `focusos_tasks?select=images&id=eq.${taskId}`);
  expect(rows.length, `task ${taskId} must still exist`).toBe(1);
  return (rows[0].images as string[] | null) ?? [];
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

/** Object names directly under the demo user's folder in the image bucket. */
const listStorage = async (request: APIRequestContext, s: Session): Promise<string[]> => {
  const res = await request.post(`${SUPABASE_URL}/storage/v1/object/list/${IMAGE_BUCKET}`, {
    headers: restHeaders(s),
    data: { prefix: `${s.userId}/`, limit: 1000 },
  });
  if (!res.ok()) return [];
  const rows = (await res.json()) as Array<{ name?: string }>;
  return rows
    .map((r) => r.name ?? '')
    .filter((n) => n !== '' && n !== '.emptyFolderPlaceholder');
};

/**
 * Seed `total` COMPLETED zz rows for the demo user, `withImages` of them holding a
 * photo path, in batches of 500. PostgREST takes an array, but every object in one
 * batch must carry the SAME keys, so `images` is present on all of them. Completed,
 * so none of them renders in the open list — the image read covers completed rows
 * too, which is exactly what makes them count here.
 */
const seedBulk = async (
  request: APIRequestContext,
  s: Session,
  stamp: number,
  total: number,
  withImages: number,
): Promise<void> => {
  const BATCH = 500;
  for (let from = 0; from < total; from += BATCH) {
    const rows: Array<Record<string, unknown>> = [];
    for (let n = from; n < Math.min(from + BATCH, total); n++) {
      rows.push({
        user_id: s.userId,
        project_id: null,
        title: `zz-bulk-${stamp}-${n}`,
        status: 'completed',
        priority: 'medium',
        images: n < withImages ? [`${s.userId}/zz-persist-${n}.png`] : [],
      });
    }
    const res = await request.post(`${SUPABASE_URL}/rest/v1/focusos_tasks`, {
      headers: restHeaders(s, { Prefer: 'return=minimal' }),
      data: rows,
    });
    expect(res.ok(), `bulk seed at ${from} must succeed (${res.status()})`).toBeTruthy();
  }
};

/**
 * Delete every row this run created, PROVE the deletes landed, sweep the demo
 * user's folder in the image bucket (empty at baseline, so anything there belongs
 * to this run), and assert the account is back to its pristine shape. Never throws:
 * it returns a list of problems, so a cleanup failure can be reported without
 * swallowing a real test failure.
 */
const cleanup = async (
  request: APIRequestContext,
  s: Session,
): Promise<string[]> => {
  const problems: string[] = [];
  try {
    // ONE bulk delete: the large-account case seeds over a thousand rows, far too
    // many to delete individually. The follow-up select is the proof it landed.
    const del = await request.delete(
      `${SUPABASE_URL}/rest/v1/focusos_tasks?user_id=eq.${s.userId}&title=like.zz-*`,
      { headers: restHeaders(s, { Prefer: 'return=minimal' }) },
    );
    if (!del.ok()) problems.push(`zz task delete: HTTP ${del.status()}`);
    const left = await restSelect(request, s, 'focusos_tasks?select=id,title&title=like.zz-*');
    if (left.length) problems.push(`zz tasks left behind: ${left.length}`);

    // Attaching a photo through the pane is a REAL upload, so the bucket is swept
    // too, and the sweep is proved by a fresh listing. Retried: a delete has been
    // seen to answer 200 "Successfully deleted" while the very next listing still
    // named the object, so one round is not proof.
    let objects = await listStorage(request, s);
    for (let round = 0; round < 3 && objects.length > 0; round++) {
      for (const name of objects) {
        const obj = await request.delete(
          `${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${s.userId}/${name}`,
          { headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.token}` } },
        );
        if (!obj.ok() && obj.status() !== 404) problems.push(`storage ${name}: HTTP ${obj.status()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      objects = await listStorage(request, s);
    }
    if (objects.length) problems.push(`storage objects survived: ${objects.join(', ')}`);

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

// ---- the app ------------------------------------------------------------------

const signIn = async (page: Page) => {
  await page.goto(`${BASE}/auth`);
  const panel = page.getByRole('tabpanel');
  await panel.getByLabel(/email/i).fill(DEMO_EMAIL);
  await panel.getByLabel(/password/i).first().fill(DEMO_PASSWORD);
  await panel.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/home', { timeout: 20000 });
};

/**
 * Open the Unassigned list in List view at FULL density. Unassigned because the
 * demo account's own seven tasks all sit in projects, so the only card in this
 * list is the seeded one; Full because the image badge lives in the expanded
 * block of the card (src/components/TaskListItem.tsx, isExpanded).
 */
const openApp = async (page: Page) => {
  await page.goto(`${BASE}/app?view=unassigned`);
  const viewSeg = page.locator('.lg-seg:not(.lg-density)');
  await expect(viewSeg).toBeVisible({ timeout: 20000 });
  await viewSeg.getByRole('button', { name: 'List' }).click();
  const density = page.locator('.lg-density');
  await expect(density).toBeVisible({ timeout: 10000 });
  await density.getByRole('button', { name: 'Full' }).click();
};

const cardFor = (page: Page, title: string): Locator =>
  page.locator('[data-task-card]').filter({ hasText: title });

/**
 * The image badge: the span inside the card's image button (the button holding
 * svg.lucide-image). `:visible` picks the desktop block — the card renders a
 * mobile layout too, hidden at this width.
 */
const badgeOf = (card: Locator): Locator =>
  card.locator('button:has(svg.lucide-image):visible span');

/**
 * Assert the badge reads `count` and KEEPS reading it for `ms`. The defect does
 * not fail the first sample: it clears the badge a beat after the refetch
 * resolves, so a single assertion right after the response can pass on the
 * broken build. Sampling across a window is what makes this discriminating.
 */
const expectBadgeHolds = async (card: Locator, count: string, ms = 2500) => {
  const badge = badgeOf(card);
  const deadline = Date.now() + ms;
  await expect(badge).toHaveText(count, { timeout: 10000 });
  while (Date.now() < deadline) {
    await expect(badge, 'the image badge must not disappear after the refetch').toHaveText(count);
    await card.page().waitForTimeout(200);
  }
};

/** The OPEN-task select the list load / resync / warm return all issue. */
const isOpenTaskSelect = (url: string) =>
  url.includes('/rest/v1/focusos_tasks') && url.includes('status=neq.completed');

const openEditPane = async (page: Page, card: Locator): Promise<Locator> => {
  await card.locator('[title="Edit task"]:visible').click();
  const pane = page.locator('[data-side-panel]');
  await expect(pane).toBeVisible({ timeout: 10000 });
  return pane;
};

const galleryLabel = (pane: Locator): Locator =>
  pane.getByRole('button', { name: /Choose from Gallery/ });

/**
 * Wait until the image reads have stopped arriving. One response is not the end of
 * the pass: an empty own-read is retried twice (appDataFetchers EMPTY_RETRY_DELAYS)
 * before the app accepts "no photos", and it is only after that that a save is
 * allowed to write the column. A quiet window is the honest signal — there is no
 * response left to await once the last read has landed.
 */
const settleImageReads = async (page: Page, quietMs = 2500) => {
  let last = Date.now();
  const onResponse = (r: Response) => {
    if (r.url().includes(IMAGE_SELECT)) last = Date.now();
  };
  page.on('response', onResponse);
  while (Date.now() - last < quietMs) await page.waitForTimeout(200);
  page.off('response', onResponse);
};

// ---- cases ---------------------------------------------------------------------

test.describe('task images survive a refetch (TP1)', () => {
  /**
   * One seeded OPEN task carrying `opts.images` image paths (1 by default), the
   * optional bulk filler behind it, and the cleanup that always runs — the body is
   * wrapped in try/catch so a failing case still hands the demo account back clean.
   */
  const withSeededTask = async (
    request: APIRequestContext,
    body: (ctx: { s: Session; taskId: string; title: string; images: string[] }) => Promise<void>,
    opts: { images?: number; bulk?: { total: number; withImages: number } } = {},
  ) => {
    const s = await restSignIn(request);
    const stamp = Date.now();
    const title = `zz-persist ${stamp}`;
    const images = Array.from(
      { length: opts.images ?? 1 },
      (_, i) => `${s.userId}/zz-persist-${stamp}-${i + 1}.png`,
    );
    let bodyError: Error | null = null;
    let taskId = '';
    try {
      if (opts.bulk) await seedBulk(request, s, stamp, opts.bulk.total, opts.bulk.withImages);
      taskId = await restInsert(request, s, {
        user_id: s.userId,
        project_id: null,
        title,
        status: 'todo',
        priority: 'medium',
        images,
      });
      await body({ s, taskId, title, images });
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

  test('(a) a focus resync keeps the image badge', async ({ page, request }) => {
    test.setTimeout(180_000);
    await withSeededTask(request, async ({ title }) => {
      await signIn(page);
      await openApp(page);

      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 20000 });
      // The badge only appears once the deferred image hydration lands (~1s).
      await expect(badgeOf(card)).toHaveText('1', { timeout: 20000 });

      const resync = page.waitForResponse(
        (r) => isOpenTaskSelect(r.url()) && r.request().method() === 'GET',
        { timeout: 30000 },
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await resync;

      await expectBadgeHolds(card, '1');
    });
  });

  test('(b) after a focus resync, Edit + Save keeps the stored image', async ({ page, request }) => {
    test.setTimeout(180_000);
    await withSeededTask(request, async ({ s, taskId, title }) => {
      await signIn(page);
      await openApp(page);

      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(badgeOf(card)).toHaveText('1', { timeout: 20000 });

      const resync = page.waitForResponse(
        (r) => isOpenTaskSelect(r.url()) && r.request().method() === 'GET',
        { timeout: 30000 },
      );
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await resync;
      // Let the refetched rows commit before the pane seeds itself from them.
      await page.waitForTimeout(1500);

      // DELIBERATE ORDER: save FIRST, assert the DATABASE first. The gallery
      // count is only the symptom; the defect this case exists for is the write
      // that follows it, so the run must reach the save even when the pane has
      // already been seeded with no images (which is what the broken build
      // does). Asserting (1/8) up here would abort before the data loss.
      const pane = await openEditPane(page, card);
      const galleryText = (await galleryLabel(pane).textContent())?.trim() ?? '';

      const saved = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/focusos_tasks') && r.request().method() === 'PATCH',
        { timeout: 30000 },
      );
      await pane.getByRole('button', { name: 'Save Changes' }).click();
      await saved;

      await expect
        .poll(async () => (await readImages(request, s, taskId)).length, { timeout: 20000 })
        .toBe(1);
      expect(galleryText, 'the edit pane must have seen the image it was about to save')
        .toContain('(1/8)');
    });
  });

  test('(c) a faked warm return keeps the badge and the stored image', async ({ page, request }) => {
    test.setTimeout(180_000);
    await withSeededTask(request, async ({ s, taskId, title }) => {
      // Fake visibility BEFORE any navigation: document.visibilityState has no
      // setter, so the page gets a settable one plus a helper that fires the
      // event the app listens on.
      await page.addInitScript(() => {
        let state: 'visible' | 'hidden' = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
        (window as unknown as Tp1Window).__tp1SetVisibility = (next: 'visible' | 'hidden') => {
          state = next;
          document.dispatchEvent(new Event('visibilitychange'));
        };
      });
      // A controllable clock, left RUNNING so the app loads normally; the jump
      // below is what makes the >60s warm-return branch fire.
      await page.clock.install({ time: new Date() });
      await page.clock.resume();

      await signIn(page);
      await openApp(page);

      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(badgeOf(card)).toHaveText('1', { timeout: 20000 });

      await page.evaluate(() => (window as unknown as Tp1Window).__tp1SetVisibility?.('hidden'));
      await page.clock.fastForward(61_000);

      const fresh = page.waitForResponse(
        (r) => isOpenTaskSelect(r.url()) && r.request().method() === 'GET',
        { timeout: 30000 },
      );
      await page.evaluate(() => (window as unknown as Tp1Window).__tp1SetVisibility?.('visible'));
      await fresh;

      await expectBadgeHolds(card, '1');
      expect(await readImages(request, s, taskId), 'the warm return must not touch the row').toHaveLength(1);
    });
  });

  test('(d) removing the image still writes an empty array', async ({ page, request }) => {
    test.setTimeout(180_000);
    await withSeededTask(request, async ({ s, taskId, title }) => {
      await signIn(page);
      await openApp(page);

      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(badgeOf(card)).toHaveText('1', { timeout: 20000 });

      const pane = await openEditPane(page, card);
      await expect(galleryLabel(pane)).toContainText('(1/8)');

      const thumb = pane.locator('img[alt="Upload 1"]');
      await expect(thumb).toBeVisible({ timeout: 10000 });
      await thumb.hover();
      await thumb.locator('xpath=following-sibling::button').click();
      await expect(galleryLabel(pane), 'the gallery must drop to 0 once removed').toContainText('(0/8)');

      const saved = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/focusos_tasks') && r.request().method() === 'PATCH',
        { timeout: 30000 },
      );
      await pane.getByRole('button', { name: 'Save Changes' }).click();
      await saved;

      await expect
        .poll(async () => (await readImages(request, s, taskId)).length, { timeout: 20000 })
        .toBe(0);
      await expect(badgeOf(card), 'the badge must go with the image').toHaveCount(0, { timeout: 15000 });
    });
  });

  test('(e) a 1,100-task account still hydrates the badge, and Save keeps the photo', async ({ page, request }) => {
    test.setTimeout(420_000);
    await withSeededTask(request, async ({ s, taskId, title }) => {
      await signIn(page);
      await openApp(page);
      await expect(cardFor(page, title)).toBeVisible({ timeout: 30000 });

      // Watch the image reads of the RELOAD: openApp navigates afresh, so nothing
      // is served from the React Query cache and hydration goes to the network.
      const reads: Array<{ url: string; rows: Promise<number> }> = [];
      const onResponse = (r: Response) => {
        if (!r.url().includes(IMAGE_SELECT)) return;
        reads.push({
          url: r.url(),
          rows: r.text().then((b) => (JSON.parse(b) as unknown[]).length).catch(() => -1),
        });
      };
      page.on('response', onResponse);
      const firstRead = page.waitForResponse((r) => r.url().includes(IMAGE_SELECT), { timeout: 90000 });
      await openApp(page);
      await firstRead;

      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 30000 });
      // The badge IS the bug: under a capped, unordered read this row falls outside
      // the returned window and the badge never comes back after the reload.
      await expect(badgeOf(card)).toHaveText('1', { timeout: 60000 });
      page.off('response', onResponse);

      expect(reads.length, 'the reload must issue at least one image read').toBeGreaterThan(0);
      expect(
        reads.filter((r) => r.url.includes('limit=1000')).map((r) => r.url),
        'no image read may carry the 1,000-row cap',
      ).toEqual([]);
      const counts = await Promise.all(reads.map((r) => r.rows));
      expect(
        counts.reduce((a, b) => a + b, 0),
        'the image reads must return every row holding photos (200 filler + 1 seeded), and only those',
      ).toBe(201);

      const pane = await openEditPane(page, card);
      await expect(galleryLabel(pane)).toContainText('(1/8)');
      const saved = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/focusos_tasks') && r.request().method() === 'PATCH',
        { timeout: 30000 },
      );
      await pane.getByRole('button', { name: 'Save Changes' }).click();
      await saved;

      await expect
        .poll(async () => (await readImages(request, s, taskId)).length, { timeout: 20000 })
        .toBe(1);
    }, { bulk: { total: 1100, withImages: 200 } });
  });

  test('(f) a save cannot wipe photos this device never loaded', async ({ page, request }) => {
    test.setTimeout(240_000);
    await withSeededTask(request, async ({ s, taskId, title, images }) => {
      // "Photos not loaded", forced: every image read answers empty, which is exactly
      // what a capped read does to a row that falls outside its window. The stored row
      // is untouched, so the app is saving against a set it has never seen.
      await page.route(
        (url) => url.href.includes(IMAGE_SELECT),
        (route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '[]',
        }),
      );
      // The realtime socket has to go with it: a postgres_changes payload carries the
      // WHOLE row, `images` included, so a single echo would hand the app the very
      // photos this case says it has never seen and the premise would be gone.
      await page.routeWebSocket(/realtime\/v1\/websocket/, () => { /* never connected */ });

      await signIn(page);
      // Wait for the (empty) image read itself: only once it has landed does the app
      // believe it knows this task's photos, which is the state the save must survive.
      const hydrated = page.waitForResponse((r) => r.url().includes(IMAGE_SELECT), { timeout: 60000 });
      await openApp(page);
      await hydrated;
      await settleImageReads(page);
      const card = cardFor(page, title);
      await expect(card).toBeVisible({ timeout: 30000 });
      await expect(badgeOf(card), 'nothing hydrated, so there is no badge').toHaveCount(0);

      const pane = await openEditPane(page, card);
      await expect(galleryLabel(pane), 'the pane sees no photos at all').toContainText('(0/8)');
      const saved = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/focusos_tasks') && r.request().method() === 'PATCH',
        { timeout: 30000 },
      );
      await pane.getByRole('button', { name: 'Save Changes' }).click();
      await saved;

      expect(
        await readImages(request, s, taskId),
        'a save that touched no photos must leave the stored ones alone',
      ).toEqual(images);

      // Fresh load, still blind (the route outlives the reload, and the realtime echo
      // of that first save does not). Now ADD a photo: the new path must JOIN the
      // stored pair, never replace it.
      const hydrated2 = page.waitForResponse((r) => r.url().includes(IMAGE_SELECT), { timeout: 60000 });
      await openApp(page);
      await hydrated2;
      await settleImageReads(page);
      const card2 = cardFor(page, title);
      await expect(card2).toBeVisible({ timeout: 30000 });
      await expect(badgeOf(card2), 'the reload hydrates nothing either').toHaveCount(0);

      // EditTaskDialog mounts fresh on every open and resolves its own user before it
      // can upload anything, so wait for that round trip instead of racing it.
      const authed = page.waitForResponse((r) => r.url().includes('/auth/v1/user'), { timeout: 30000 });
      const pane2 = await openEditPane(page, card2);
      await authed;
      const uploaded = page.waitForResponse(
        (r) => r.url().includes('/storage/v1/object/') && r.request().method() === 'POST',
        { timeout: 30000 },
      );
      await pane2.locator('#edit-file-input').setInputFiles({
        name: 'zz-pixel.png',
        mimeType: 'image/png',
        buffer: PIXEL_PNG,
      });
      await uploaded;
      await expect(galleryLabel(pane2), 'the upload must land in the pane').toContainText('(1/8)');

      const saved2 = page.waitForResponse(
        (r) => r.url().includes('/rest/v1/focusos_tasks') && r.request().method() === 'PATCH',
        { timeout: 30000 },
      );
      await pane2.getByRole('button', { name: 'Save Changes' }).click();
      await saved2;

      await expect
        .poll(async () => (await readImages(request, s, taskId)).length, { timeout: 20000 })
        .toBe(3);
      const after = await readImages(request, s, taskId);
      expect(after.slice(0, 2), 'the stored photos keep their place, first').toEqual(images);
    }, { images: 2 });
  });
});
