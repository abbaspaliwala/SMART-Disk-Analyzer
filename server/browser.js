/**
 * Launch the dashboard in the user's default browser.
 *
 * `npm start`, `npm run demo` and `npm run elevated` are interactive, so opening
 * the page saves a copy-and-paste. It is skipped when there is no TTY (services,
 * CI, containers) and can be disabled with --no-browser / NO_BROWSER=1.
 */

import { spawn } from 'node:child_process';

import { which } from './partitions.js';

/** URL handlers per platform, best first. */
export const BROWSER_CANDIDATES = {
  linux: [['xdg-open', []], ['sensible-browser', []], ['x-www-browser', []], ['gio', ['open']]],
  darwin: [['open', []]],
  win32: [['explorer', []]],
};

/** Pick a browser launcher for this desktop. */
export function resolveBrowser({ platform = process.platform, env = process.env, find } = {}) {
  const lookup = find || ((command) => which(command, env));
  for (const [name, args] of BROWSER_CANDIDATES[platform] || []) {
    const command = lookup(name);
    if (command) return { command, name, args };
  }
  return null;
}

/**
 * Open `url` and resolve once the launcher has started. Browsers keep running,
 * so only the 'spawn' event is awaited, never the exit.
 */
export function openBrowser(url, { opener, platform = process.platform, env = process.env, runAs = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!opener?.command) {
      reject(new Error('no browser launcher is available'));
      return;
    }
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      reject(new Error(`refusing to open "${url}"`));
      return;
    }

    const options = { detached: true, stdio: 'ignore' };
    if (runAs && platform !== 'win32') {
      // A root-run server must hand the window to the desktop user, not root.
      options.uid = runAs.uid;
      options.gid = runAs.gid;
      options.env = { ...env, HOME: runAs.home || env.HOME, USER: runAs.username, LOGNAME: runAs.username };
    }

    let child;
    try {
      child = spawn(opener.command, [...(opener.args || []), url], options);
    } catch (error) {
      reject(new Error(`could not start ${opener.name}: ${error.message}`));
      return;
    }
    child.once('error', (error) => reject(new Error(`could not start ${opener.name}: ${error.message}`)));
    child.once('spawn', () => {
      try {
        child.unref();
      } catch {
        /* already gone */
      }
      resolve({ url, command: opener.name });
    });
  });
}

