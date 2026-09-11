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
// Cases:
//   (a) focus resync keeps the badge;
//   (b) after (a), Edit shows (1/8) and Save Changes leaves the row at 1 image;
//   (c) a faked warm return (hidden, +61s, visible) keeps badge and row;
//   (d) removing the image still works: row 0 images, badge gone.
//
// Run: PW_PORT=8094 npx playwright test tests/desktop-task-images-persist.spec.ts --project=desktop-mouse
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';

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

/**
 * Delete every row this run created, PROVE each delete landed, sweep the bucket
 * for the storage path the seed named, and assert the demo account is back to
 * its pristine baseline. Never throws: it returns a list of problems, so a
 * cleanup failure can be reported without swallowing a real test failure.
 */
const cleanup = async (
  request: APIRequestContext,
  s: Session,
  stamp: number,
  storagePath: string,
): Promise<string[]> => {
  const problems: string[] = [];
  try {
    const like = encodeURIComponent(String(stamp));
    const tasks = await restSelect(request, s, `focusos_tasks?select=id,title&title=like.*${like}*`);
    for (const t of tasks) {
      const res = await request.delete(`${SUPABASE_URL}/rest/v1/focusos_tasks?id=eq.${t.id}`, {
        headers: restHeaders(s, { Prefer: 'return=representation' }),
      });
      if (!res.ok()) { problems.push(`focusos_tasks ${t.id}: HTTP ${res.status()}`); continue; }
      const deleted = await res.json();
      if (deleted.length !== 1) problems.push(`focusos_tasks ${t.id}: delete removed ${deleted.length} rows`);
    }
    const left = await restSelect(request, s, `focusos_tasks?select=id,title&title=like.*${like}*`);
    if (left.length) problems.push(`tasks left behind: ${left.map((t) => String(t.title)).join(', ')}`);

    // Nothing is uploaded by this spec (the seed is a path string), so this is a
    // guard rather than a real delete: a 404/400 means there was no object.
    const obj = await request.delete(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${storagePath}`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.token}` },
    });
    if (obj.ok()) {
      const body = await obj.text();
      if (body.includes(storagePath)) problems.push(`storage object survived the run: ${storagePath}`);
    }

    // Pristine baseline, the same assertion tests/project-order.spec.ts ends on.
    const projects = await restCount(request, s, 'focusos_projects');
    const tasks2 = await restCount(request, s, 'focusos_tasks');
    if (projects !== BASELINE_PROJECTS) problems.push(`projects: ${projects}, baseline ${BASELINE_PROJECTS}`);
    if (tasks2 !== BASELINE_TASKS) problems.push(`tasks: ${tasks2}, baseline ${BASELINE_TASKS}`);
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

// ---- cases ---------------------------------------------------------------------

test.describe('task images survive a refetch (TP1)', () => {
  /** One seeded open task carrying exactly one image path, plus its cleanup. */
  const withSeededTask = async (
    request: APIRequestContext,
    body: (ctx: { s: Session; taskId: string; title: string; storagePath: string }) => Promise<void>,
  ) => {
    const s = await restSignIn(request);
    const stamp = Date.now();
    const title = `zz-persist ${stamp}`;
    const storagePath = `${s.userId}/zz-persist-${stamp}.png`;
    let bodyError: Error | null = null;
    let taskId = '';
    try {
      taskId = await restInsert(request, s, {
        user_id: s.userId,
        project_id: null,
        title,
        status: 'todo',
        priority: 'medium',
        images: [storagePath],
      });
      await body({ s, taskId, title, storagePath });
    } catch (e) {
      bodyError = e as Error;
    }
    const problems = await cleanup(request, s, stamp, storagePath);
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
});
