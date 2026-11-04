import base from './playwright.config.ts';
export default { ...base, projects: base.projects!.map((p) => ({ ...p, use: { ...p.use, launchOptions: { executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome' } } })) };
