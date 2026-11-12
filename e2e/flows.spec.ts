// End-to-end flows through the real UI on a fresh demo database.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('sign in rejects a wrong password, then signs in', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email').fill('teacher@krubook.test');
  await page.locator('#password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/do not match an account/)).toBeVisible();
  await page.locator('#password').fill('krubook-demo');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#password')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Review' }).first()).toBeVisible();
  await page.context().storageState({ path: 'e2e-results/auth.json' });
});

test.describe('signed in', () => {
  test.use({ storageState: 'e2e-results/auth.json' });

  test('review: decide one past session, preview, apply; the other stays', async ({ page }) => {
    const before = await (await page.request.get('/api/reconcile/sessions')).json();
    expect(before.length).toBe(2);
    await page.goto('/review');
    await page.getByLabel(/^Decision for /).first().selectOption('taught');
    await page.getByRole('button', { name: 'Preview impact' }).click();
    await expect(page.getByRole('heading', { name: 'Impact of these decisions' })).toBeVisible();
    await page.getByRole('button', { name: /^Apply/ }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByLabel(/^Decision for /)).toHaveCount(1);
    const after = await (await page.request.get('/api/reconcile/sessions')).json();
    expect(after.map((s: any) => s.sessionId)).toEqual([before[1].sessionId]);
  });

  test('pay: approve a month, then undo the approval', async ({ page }) => {
    await page.goto('/pay');
    // Pay months run 16th of the previous month to the 15th.
    await expect(page.getByText('September 2026')).toBeVisible();
    await expect(page.getByText('16 Aug – 15 Sep')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await expect(page.getByText(/^Approved \$/).first()).toBeVisible();
    const approved = await (await page.request.get('/api/pay?year=2026')).json();
    expect(JSON.stringify(approved)).toContain('"approved"');
    await page.getByRole('button', { name: 'Statement' }).first().click();
    await page.getByRole('menuitem', { name: 'Undo approval' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Undo approval' }).click();
    await expect(page.getByText(/^Approved \$/)).toHaveCount(0);
  });

  test('holidays: a 3-day range is one entry; remove asks first', async ({ page }) => {
    await page.goto('/settings#holidays');
    await page.locator('#hh-from').fill('2026-12-21');
    await page.locator('#hh-to').fill('2026-12-23');
    await page.locator('#hh-name').fill('E2E test break');
    await page.getByRole('button', { name: 'Add holiday' }).click();
    await expect(page.getByText('E2E test break')).toHaveCount(1);
    const mine = ((await (await page.request.get('/api/holidays')).json()) as any[]).filter((h) => h.name === 'E2E test break');
    expect(mine).toEqual([expect.objectContaining({ date: '2026-12-21', end_date: '2026-12-23' })]);
    // The timetable marks every day of the range, not only the first.
    await page.goto('/timetable?week=2026-12-21');
    await expect(page.locator('.tt-holiday', { hasText: 'E2E test break' })).toHaveCount(3);
    // The holiday name sits in the day header, and the timetable has no scroll box of its own:
    // the page is the only thing that scrolls, so the day headers can stay in view.
    await expect(page.locator('.tt-head .tt-holiday')).toHaveCount(3);
    const inner = await page.locator('.tt-panel').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { x: cs.overflowX, y: cs.overflowY, wider: el.scrollWidth > el.clientWidth + 1 };
    });
    expect(inner).toEqual({ x: 'clip', y: 'clip', wider: false });
    await page.goto('/settings#holidays');
    await page.getByRole('button', { name: 'Remove E2E test break' }).click();
    await expect(page.getByRole('dialog')).toContainText('All 3 days');
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('E2E test break')).toHaveCount(0);
  });

  test('holidays: a class planned on a holiday is shown as off on the timetable', async ({ page }) => {
    const made = await (await page.request.post('/api/holidays', { data: { date: '2026-10-28', name: 'E2E strike day' } })).json();
    await page.goto('/timetable?week=2026-10-26');
    await expect(page.locator('.tt-head .tt-holiday', { hasText: 'E2E strike day' })).toContainText('No classes');
    expect(await page.locator('.tt-ev.on-holiday').count()).toBeGreaterThan(0);
    // A class on the holiday is shown as off, without needing anything done first.
    await expect(page.locator('.tt-ev.on-holiday.cancelled').first()).toContainText('Holiday: E2E strike day — no class');
    await expect(page.getByRole('button', { name: 'Check classes against holidays' })).toBeVisible();
    await page.request.delete(`/api/holidays/${made.id}`);
    await page.reload();
    await expect(page.locator('.tt-ev.on-holiday')).toHaveCount(0);
  });

  test('ask for leave: pick the day, classes and reason; the message is written in the usual format', async ({ page }) => {
    await page.goto('/timetable?week=2026-10-26');
    await page.getByRole('button', { name: 'Ask for leave' }).click();
    await page.locator('#leave-date').fill('2026-10-26');
    const boxes = page.getByRole('dialog').getByRole('checkbox');
    await expect(boxes).toHaveCount(2); // Mon 26 Oct: ASL3 07:30 and SW43 13:30
    await boxes.first().uncheck();
    await page.locator('#leave-name').fill('Sreng Sokheng');
    await page.getByRole('button', { name: 'ខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)' }).click();
    await expect(page.locator('#leave-text')).toHaveValue('ជម្រាបសួរលោកគ្រូ ខ្ញុំសូមអនុញ្ញាតច្បាប់\nSRENG SOKHENG MON 26-10-2026 (1:30 PM - 2:30 PM ONLY)\nដោយសារខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)។ សូមអរគុណ ។');
    await expect(page.getByRole('link', { name: 'Send with Telegram' })).toHaveAttribute('href', /t\.me\/share/);
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    // From a class itself, that class is chosen.
    await page.locator('.tt-ev', { hasText: 'SW43' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ask for leave' }).click();
    await expect(page.getByRole('dialog').getByRole('checkbox', { checked: true })).toHaveCount(1);
  });

  test('attendance: ticking a student saves, and the tick survives a reload', async ({ page }) => {
    await page.goto('/classes/1/attendance');
    const box = page.getByRole('checkbox', { name: /^0230002 / });
    const was = (await box.getAttribute('aria-checked')) === 'true';
    await box.click();
    await expect(box).toHaveAttribute('aria-checked', String(!was));
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^0230002 / })).toHaveAttribute('aria-checked', String(!was));
  });

  test('attendance: starting a roll call counts everyone left unticked as absent', async ({ page }) => {
    await page.goto('/classes/1/attendance');
    const sessions = page.getByRole('combobox', { name: 'Session' });
    // Pick a session that has no roll call yet, if the demo has one; otherwise clear the latest.
    const fresh = await sessions.locator('option').evaluateAll((os) => (os as HTMLOptionElement[]).find((o) => !o.text.includes('marked'))?.value ?? null);
    if (fresh) await sessions.selectOption(fresh);
    else {
      await page.getByRole('button', { name: 'Clear', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Clear roll call' }).click();
    }
    await expect(page.getByText('Roll call not taken yet')).toBeVisible();
    await page.getByRole('checkbox', { name: /^0230002 / }).click();
    await expect(page.locator('.panel-head').getByText('1 came')).toBeVisible();
    const absent = await page.locator('.roll-row.away').count();
    expect(absent).toBeGreaterThan(10);
    await expect(page.locator('.roll-row.unmarked')).toHaveCount(0);
  });

  test('check-in: one tap on the dashboard records the arrival and survives a reload', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Check in' }).first();
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole('button', { name: /^In \d\d:\d\d · / }).first()).toBeVisible();
    await page.reload();
    const badge = page.getByRole('button', { name: /^In \d\d:\d\d · / }).first();
    await expect(badge).toBeVisible();
    // Correct the time by hand, then remove it again.
    await badge.click();
    await page.locator('#ci-time').fill('08:05');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: 'In 08:05 · 5 min late' })).toBeVisible();
    await page.getByRole('button', { name: 'In 08:05 · 5 min late' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove check-in' }).click();
    await expect(page.getByRole('button', { name: 'Check in' }).first()).toBeVisible();
  });

  test('update from Excel: dropping a workbook previews the changes without saving', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Workbook file').setInputFiles('e2e-results/workbook.xlsx'); // written by e2e/server.ts
    await expect(page.getByText('Scores to add')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Left as they are' })).toBeVisible();
    await page.getByLabel('Workbook file').setInputFiles({ name: 'notes.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a workbook') });
    await expect(page.getByText(/could not be read as an Excel workbook/)).toBeVisible();
  });

  test('gradebook: a valid score saves, an out-of-range score is refused', async ({ page }) => {
    await page.goto('/classes/1/grades');
    const cell = page.locator('input[aria-label$=" for 0230001"]').first();
    await cell.fill('3'); // LAB 1 is out of 5
    await cell.press('Enter');
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.locator('input[aria-label$=" for 0230001"]').first()).toHaveValue('3');
    const again = page.locator('input[aria-label$=" for 0230001"]').first();
    await again.fill('9999');
    await again.press('Enter');
    await expect(page.locator('td.cell.invalid').first()).toBeVisible();
  });

  test('preferences follow the account to another device; tables default to 10 rows', async ({ page, browser }) => {
    await page.goto('/students');
    await expect(page.getByText(/^1–10 of/)).toBeVisible();
    await page.getByLabel('Rows per page').selectOption('25');
    await expect(page.getByText(/^1–25 of/)).toBeVisible();
    // A second "device": a fresh browser with no cached data, signing in to the same account.
    const other = await browser.newPage({ storageState: undefined });
    await other.goto('/');
    await other.locator('#email').fill('teacher@krubook.test');
    await other.locator('#password').fill('krubook-demo');
    await other.getByRole('button', { name: 'Sign in' }).click();
    await expect(other.locator('#password')).toHaveCount(0);
    await other.goto('/students');
    await expect(other.getByText(/^1–25 of/)).toBeVisible();
    await other.getByRole('button', { name: 'ខ្មែរ' }).first().click();
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('km');
    // Put things back for the page tests.
    await page.getByRole('button', { name: 'English' }).first().click();
    await page.getByLabel('Rows per page').selectOption('10');
    await other.close();
  });

  test('accounts: an admin adds a teacher, who chooses a password and sees only their own (empty) data', async ({ page, browser }) => {
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Add account' }).click();
    await page.locator('#acc-name').fill('New Teacher');
    await page.locator('#acc-email').fill('new.teacher@krubook.test');
    await page.locator('#acc-until').fill('2027-01-31');
    await page.getByRole('dialog').getByRole('button', { name: 'Create account' }).click();
    const dialog = page.getByRole('dialog', { name: 'Account created' });
    await expect(dialog).toBeVisible();
    const temp = (await dialog.locator('dd b').textContent())!.trim();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('new.teacher@krubook.test')).toBeVisible();

    const other = await browser.newPage({ storageState: undefined });
    await other.goto('/');
    await other.locator('#email').fill('new.teacher@krubook.test');
    await other.locator('#password').fill(temp);
    await other.getByRole('button', { name: 'Sign in' }).click();
    await expect(other.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
    await other.locator('#cp-current').fill(temp);
    await other.locator('#cp-next').fill('new-teacher-pass');
    await other.locator('#cp-again').fill('new-teacher-pass');
    await other.getByRole('button', { name: 'Save and continue' }).click();
    await expect(other.getByRole('heading', { name: 'No classes today' })).toBeVisible();
    await other.goto('/classes');
    await expect(other.getByText('ASL3')).toHaveCount(0);
    await expect(other.getByRole('link', { name: 'Accounts' })).toHaveCount(0);
    await other.close();
  });

  test('pay: "Why this amount" shows the month from the full timetable down to Actual', async ({ page }) => {
    await page.goto('/pay');
    await page.getByRole('button', { name: 'Why this amount' }).nth(1).click();
    await expect(page.getByText('Full timetable')).toBeVisible();
    await expect(page.getByText(/^Holiday: /).first()).toBeVisible();
    await expect(page.locator('.breakdown tr.total')).toContainText('Actual');
    await page.getByRole('button', { name: 'Hide breakdown' }).click();
    await expect(page.getByText('Full timetable')).toHaveCount(0);
  });

  test('pay sessions: filter by month, switch to the calendar, and add a forgotten arrival', async ({ page }) => {
    await page.goto('/pay#sessions');
    await expect(page.getByText(/classes worked/)).toBeVisible();
    await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Calendar month' }).click();
    await page.getByLabel('Month').selectOption('2026-10');
    await expect(page.getByText(/of \d+ classes worked/)).toBeVisible();
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Calendar' }).click();
    // A past class without a teaching record: adding the arrival makes it worked.
    const missing = page.locator('.paycal-ev.not-recorded').first();
    await expect(missing).toBeVisible();
    const name = (await missing.getAttribute('aria-label'))!.split(' Not recorded')[0];
    await missing.click();
    await page.locator('#ci-time').fill(name.split(' ')[2]);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator(`.paycal-ev[aria-label^="${name} Worked"]`)).toBeVisible();
  });

  test('exams & files: upload a midterm paper, see it listed, download it', async ({ page }) => {
    await page.goto('/classes/1/files');
    await page.getByLabel('Files to upload').setInputFiles({ name: 'Midterm 2026.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('PK fake paper') });
    await expect(page.getByText('Midterm 2026.docx ·')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).first().click()]);
    expect(dl.suggestedFilename()).toBe('Midterm 2026.docx');
  });

  test('lesson slides: upload a sample deck and a book, write a lesson, edit it, download PowerPoint', async ({ page }) => {
    await page.goto('/slides');
    await page.getByLabel('Sample deck or book to upload').setInputFiles(['e2e-results/sample.pptx', 'e2e-results/book.pdf']); // written by e2e/server.ts
    await expect(page.getByText('sample.pptx ·')).toBeVisible();
    await expect(page.getByText('book.pdf ·')).toBeVisible();
    await expect(page.getByText('8 pages · 2 lessons')).toBeVisible();
    // Choosing a lesson of the book fills in its pages, number, title and the next lesson.
    await page.locator('#sl-lesson').selectOption({ label: 'Lesson 1: The Basics' });
    await expect(page.getByText('Pages 2–4 of the PDF · lesson 1 “The Basics” · next: “Loops and More”')).toBeVisible();
    await expect(page.locator('#sl-from')).toHaveCount(0);
    // "Change" opens the details to adjust them.
    await page.getByRole('button', { name: 'Change' }).click();
    await expect(page.locator('#sl-from')).toHaveValue('2');
    await page.locator('#sl-title').fill('Control Statements');
    await page.getByRole('button', { name: 'Write lesson' }).click();
    await expect(page.getByText('3 slides', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Check and edit' }).click();
    const second = page.getByRole('region', { name: 'Slide 2' });
    await second.locator('textarea').first().fill('If statements');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PowerPoint' }).click()]);
    expect(dl.suggestedFilename()).toBe('Control Statements.pptx');
  });

  test('AI for lesson slides: the administrator switches to Gemini and back to Claude Haiku', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('#ai-provider').selectOption('gemini');
    await expect(page.locator('#ai-model')).toHaveValue('gemini-3.6-flash');
    await page.getByRole('button', { name: 'Use this' }).click();
    await expect.poll(async () => (await (await page.request.get('/api/slides/status')).json()).provider).toBe('gemini');
    await page.locator('#ai-provider').selectOption('anthropic');
    await expect(page.locator('#ai-model')).toHaveValue('claude-haiku-5-5');
    await page.getByRole('button', { name: 'Use this' }).click();
    await expect.poll(async () => (await (await page.request.get('/api/slides/status')).json())).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  test('groups: make groups, give a group score and an individual score, see them in the gradebook', async ({ page }) => {
    await page.goto('/classes/1/groups');
    await page.getByRole('button', { name: 'New group list' }).click();
    await page.locator('#gs-name').fill('Final project');
    const final = page.locator('#gs-column option', { hasText: 'Final' }).first();
    await page.locator('#gs-column').selectOption({ label: (await final.textContent())!.trim() });
    await page.locator('#gs-groupmax').fill('10');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Make groups automatically…' }).click();
    await page.locator('#split-size').fill('3');
    await page.getByRole('dialog').getByRole('button', { name: 'Make groups' }).click();
    const g1 = page.getByRole('region', { name: 'Group 1', exact: true });
    await expect(g1).toBeVisible();
    await g1.getByLabel('Topic of Group 1', { exact: true }).fill('Library system');
    await g1.getByRole('button', { name: 'Save group details' }).click();
    await expect(page.getByText('Group saved')).toBeVisible();
    const firstCode = (await g1.locator('td .mono').first().textContent())!.trim();
    await g1.getByLabel('Group score of Group 1', { exact: true }).fill('8');
    await g1.getByLabel(`Individual score of ${firstCode}`).fill('2.5');
    await g1.getByRole('button', { name: /^Save marks to/ }).click();
    await expect(g1.getByRole('cell', { name: '10.5', exact: true })).toBeVisible();
    // Search finds the group by topic, and by a member's ID.
    await page.getByLabel('Search groups').fill('library');
    await expect(page.getByRole('region', { name: /^Group \d+$/ })).toHaveCount(1);
    await page.getByLabel('Search groups').fill(firstCode);
    await expect(page.getByRole('region', { name: 'Group 1', exact: true })).toBeVisible();
    // The gradebook shows the mark and can show one group.
    await page.goto('/classes/1/grades');
    await page.getByLabel('Show group').selectOption({ label: 'Final project: Group 1 — Library system' });
    const count = await page.locator('table.sheet tbody tr').count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
    await expect(page.getByLabel(new RegExp(`^Final.* for ${firstCode}$`))).toHaveValue('10.5');
  });

  test('access tokens: create one, it is shown once and works, then revoke it', async ({ page, playwright }) => {
    await page.goto('/settings');
    await page.locator('#tok-name').fill('E2E helper');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = (await page.getByLabel('New access token').textContent())!.trim();
    expect(token).toMatch(/^kb_/);
    // No cookies: only the token signs this helper in.
    const helper = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4320', storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    const anon = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4320', storageState: { cookies: [], origins: [] } });
    expect((await anon.get('/api/courses')).status()).toBe(401);
    await anon.dispose();
    expect((await helper.get('/api/courses')).status()).toBe(200);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByLabel('New access token')).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect.poll(async () => (await helper.get('/api/courses')).status()).toBe(401);
    await helper.dispose();
  });

  test('theme: Light and Dark override the device, Auto follows it, and the choice survives a reload', async ({ page }) => {
    await page.goto('/');
    const themes = page.getByRole('group', { name: 'Theme' });
    await themes.getByRole('button', { name: 'Dark' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Auto' }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? 'auto')).toBe('auto');
  });

  test('sign out ends the session', async ({ browser }) => {
    // A separate sign-in so the saved session used by the page tests stays valid.
    const page = await browser.newPage({ storageState: undefined });
    await page.goto('/');
    await page.locator('#email').fill('teacher@krubook.test');
    await page.locator('#password').fill('krubook-demo');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#password')).toHaveCount(0);
    await page.request.post('/api/auth/logout');
    expect((await page.request.get('/api/classes')).status()).toBe(401);
    await page.close();
  });
});
