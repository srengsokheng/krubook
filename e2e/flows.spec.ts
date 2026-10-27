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
    await page.getByRole('button', { name: 'Remove E2E test break' }).click();
    await expect(page.getByRole('dialog')).toContainText('All 3 days');
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('E2E test break')).toHaveCount(0);
  });

  test('attendance: mark a student and the mark survives a reload', async ({ page }) => {
    await page.goto('/classes/1/attendance');
    const group = page.getByRole('radiogroup', { name: 'Attendance for 0230002' });
    const target = (await group.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')) === 'true' ? 'P' : 'A';
    await group.getByRole('radio', { name: target }).click();
    await expect(group.getByRole('radio', { name: target })).toHaveAttribute('aria-checked', 'true');
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByRole('radiogroup', { name: 'Attendance for 0230002' }).getByRole('radio', { name: target })).toHaveAttribute('aria-checked', 'true');
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
