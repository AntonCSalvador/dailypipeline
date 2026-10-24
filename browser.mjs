import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

export const viewport = { width: 1100, height: 760 };

export async function launchBrowser() {
  const executablePath = [
    process.env.BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ].find(path => path && existsSync(path));
  if (!executablePath) throw new Error('Chrome not found. Install Chrome or set BROWSER_PATH to its executable.');
  return chromium.launch({ executablePath, headless: true });
}

export const contextOptions = {
  viewport, locale: 'en-US', timezoneId: 'America/New_York',
};
