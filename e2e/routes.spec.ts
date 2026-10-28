// Visits every page and checks it renders without errors, CSP violations or sideways scrolling.
import { expect, test, type Page } from '@playwright/test';

const ROUTES = [
  '/', '/review', '/review#ids', '/timetable', '/classes',
  '/classes/1/plan', '/classes/1/attendance', '/classes/1/grades', '/classes/1/roster', '/classes/1/setup',
  '/courses', '/courses/1', '/terms', '/terms/1', '/students', '/students/1',
  '/pay', '/pay#sessions', '/pay#rates', '/pay#adjustments', '/import',
  '/settings', '/settings#holidays', '/settings#reminders', '/settings#backup', '/settings#activity',
  '/print/attendance/1', '/print/gradebook/1', '/print/plan/1',
];

test.use({ storageState: 'e2e-results/auth.json' });

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return problems;
}

for (const route of ROUTES) {
  test(`page ${route}`, async ({ page }, info) => {
    const problems = watch(page);
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#password'), 'redirected to sign-in').toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Page not found')).toHaveCount(0);
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= w + 1) return false;
        // Content inside a scrolling container (wide tables) is fine.
        for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; }
        return true;
      });
      return { page: document.documentElement.scrollWidth - w, offenders: wide.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${el.className}`) };
    });
    expect(overflow.page, `horizontal overflow: ${overflow.offenders.join(', ')}`).toBeLessThanOrEqual(1);
    // Dropdowns show their whole selected value (no "46 marl…").
    const clipped = await page.locator('select').evaluateAll((sels) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      return sels.filter((s) => (s as HTMLSelectElement).offsetWidth > 0).flatMap((el) => {
        const s = el as HTMLSelectElement, cs = getComputedStyle(s), text = s.selectedOptions[0]?.text ?? '';
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = s.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16; // 16px for the arrow
        return ctx.measureText(text).width > room + 1 ? [`${s.getAttribute('aria-label') ?? s.id}: "${text}"`] : [];
      });
    });
    expect(clipped, 'dropdowns cutting off their value').toEqual([]);
    // Segmented controls (English | ខ្មែរ, Roll call | Summary, …) split evenly.
    const uneven = await page.locator('.seg').evaluateAll((segs) => segs.filter((s) => s.getBoundingClientRect().width > 0).map((s) => [...s.children].map((b) => Math.round(b.getBoundingClientRect().width))).filter((w) => Math.max(...w) - Math.min(...w) > 1));
    expect(uneven, 'segmented controls with unequal options').toEqual([]);
    // Above phone width, data tables must lay out as tables (a stray layout class once turned them into flex columns).
    if ((page.viewportSize()?.width ?? 0) > 640) {
      const broken = await page.locator('table.table').evaluateAll((ts) => ts.filter((t) => getComputedStyle(t).display !== 'table').length);
      expect(broken, 'tables not laid out as tables').toBe(0);
    }
    await page.screenshot({ path: `e2e-results/screens/${info.project.name}/${route.replace(/[\/#]+/g, '_') || '_'}.png`, fullPage: true });
    expect(problems).toEqual([]);
  });
}
