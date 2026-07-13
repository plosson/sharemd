import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { connectPeer, startTestServer } from './helpers';
import type { ShareMdServer } from '../src/server/index';
import { AgentClient } from './mcp-client';

let server: ShareMdServer;
let vaultDir: string;
let browser: Browser;
let page: Page;
let alice: AgentClient;
let bob: AgentClient;

beforeAll(async () => {
  ({ server, vaultDir } = await startTestServer());
  browser = await chromium.launch();
  page = await browser.newPage();
  [alice, bob] = await Promise.all([
    AgentClient.spawn(server.url, 'plosson/alice'),
    AgentClient.spawn(server.url, 'plosson/bob'),
  ]);
});

afterAll(async () => {
  await Promise.all([alice.close(), bob.close()]);
  await browser.close();
  await server.stop();
});

function waitForText(selector: string, text: string, timeoutMs = 10_000) {
  return page.waitForFunction(
    ({ sel, needle }) => document.querySelector(sel)?.textContent?.includes(needle) ?? false,
    { sel: selector, needle: text },
    { timeout: timeoutMs },
  );
}

test(
  'two MCP agents and a human edit the same document concurrently without losing anything',
  async () => {
    // Human opens demo.md in the real web UI.
    await page.goto(`${server.url}/?name=Human&doc=demo.md`);
    await waitForText('.cm-content', 'Demo document');

    // Agents join the same document over MCP.
    await alice.call('open_document', { path: 'demo.md' });
    await bob.call('open_document', { path: 'demo.md' });

    // Human sees both agents in the presence bar, marked as agents of their owner.
    await waitForText('#presence', '🤖 plosson/alice');
    await waitForText('#presence', '🤖 plosson/bob');

    // All three edit at the same time.
    const humanEdits = (async () => {
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+ArrowUp'); // jump to document start
      await page.keyboard.type('HUMAN: typed live from the browser\n', { delay: 15 });
    })();

    const aliceEdits = (async () => {
      await alice.call('begin_edit', { mode: 'append' });
      await alice.call('append_text', { text: '\n## Alice was here\n\nALICE: first paragraph, streamed.\n' });
      await alice.call('append_text', { text: '\nALICE: second paragraph, streamed.\n' });
      await alice.call('commit_edit');
    })();

    const bobEdits = (async () => {
      const { matches } = await bob.call<{ matches: Array<{ matchId: string }> }>('search_text', {
        query: '- Second note',
      });
      await bob.call('place_cursor', { matchId: matches[0]!.matchId, edge: 'end' });
      await bob.call('insert_text', { text: ' (BOB: reviewed this note)' });
      await bob.call('begin_edit', { mode: 'append' });
      await bob.call('append_text', { text: '\nBOB: appended a closing line.\n' });
      await bob.call('commit_edit');
    })();

    await Promise.all([humanEdits, aliceEdits, bobEdits]);

    // Everyone converges: the browser shows all three contributions.
    await waitForText('.cm-content', 'HUMAN: typed live from the browser');
    await waitForText('.cm-content', 'ALICE: second paragraph, streamed.');
    await waitForText('.cm-content', 'BOB: reviewed this note');

    // And the merged result is persisted to the markdown file on disk.
    await server.registry.flushAll();
    const onDisk = await Bun.file(join(vaultDir, 'demo.md')).text();
    expect(onDisk).toInclude('HUMAN: typed live from the browser');
    expect(onDisk).toInclude('ALICE: first paragraph, streamed.');
    expect(onDisk).toInclude('ALICE: second paragraph, streamed.');
    expect(onDisk).toInclude('- Second note (BOB: reviewed this note)');
    expect(onDisk).toInclude('BOB: appended a closing line.');
    expect(onDisk).toInclude('# Demo document'); // original content intact
    expect(onDisk).toInclude('- First note');
  },
  90_000,
);

test(
  'remote edits flash a transient highlight attributed to the author',
  async () => {
    const carol = await connectPeer(server, 'demo.md');
    try {
      carol.provider.awareness.setLocalStateField('user', {
        name: 'Carol',
        color: '#8a4bbf',
        colorLight: '#8a4bbf33',
      });
      await waitForText('#presence', 'Carol'); // awareness propagated to the browser
      carol.text.insert(carol.text.length, '\nCAROL: watch this line appear highlighted\n');

      // Badge with the author's name shows up on the inserted range…
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.sharemd-edit-badge')].some((el) =>
            el.textContent?.includes('Carol'),
          ) && document.querySelectorAll('.sharemd-remote-edit').length > 0,
        undefined,
        { timeout: 5000 },
      );

      // …and the highlight is transient: gone shortly after.
      await page.waitForFunction(
        () => document.querySelectorAll('.sharemd-edit-badge').length === 0,
        undefined,
        { timeout: 6000 },
      );
    } finally {
      carol.destroy();
    }
  },
  30_000,
);

test(
  'agents read live human edits back over MCP',
  async () => {
    const read = await alice.call<{ text: string }>('read_document', { maxChars: 20_000 });
    expect(read.text).toInclude('HUMAN: typed live from the browser');
    expect(read.text).toInclude('BOB: appended a closing line.');
  },
  30_000,
);

test(
  'history mode replays the edit log: scrub back to the seed, play forward again',
  async () => {
    await page.click('#history-open');
    await page.waitForSelector('#history:not([hidden])');
    expect(await page.textContent('#history-title')).toBe('demo.md — history');

    // Opens at the latest entry: everything everyone wrote is there.
    await waitForText('#history-editor .cm-content', 'BOB: appended a closing line.');
    const total = Number(await page.locator('#history-slider').getAttribute('max'));
    expect(total).toBeGreaterThan(1);

    // Scrub to the first entry: the pre-edit document, no live contributions.
    await page.locator('#history-slider').evaluate((el) => {
      (el as HTMLInputElement).value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForText('#history-editor .cm-content', '# Demo document');
    const seeded = await page.textContent('#history-editor .cm-content');
    expect(seeded).not.toInclude('HUMAN: typed live from the browser');

    // Play steps forward through the log.
    await page.click('#history-play');
    await page.waitForFunction(
      () => Number(document.querySelector('#history-pos')?.textContent?.split('/')[0]) >= 4,
      undefined,
      { timeout: 10_000 },
    );
    await page.click('#history-play'); // pause
    await page.click('#history-close');
    await page.waitForSelector('#history', { state: 'hidden' });
  },
  30_000,
);

test(
  'first visit asks who you are, rejects "/", remembers the name, and logout forgets it',
  async () => {
    const context = await browser.newContext();
    const visitor = await context.newPage();
    try {
      // No stored name: the login overlay blocks the app.
      await visitor.goto(server.url);
      await visitor.waitForSelector('#login-form', { state: 'visible' });

      // "/" is reserved for agents and must be rejected for humans.
      await visitor.fill('#login-name', 'plosson/fake-agent');
      await visitor.click('#login-form button[type=submit]');
      await visitor.waitForSelector('#login-error:not([hidden])');
      expect(await visitor.textContent('#login-error')).toInclude('reserved for agents');

      // A valid name joins and is remembered.
      await visitor.fill('#login-name', 'Dana');
      await visitor.click('#login-form button[type=submit]');
      await visitor.waitForSelector('#login', { state: 'hidden' });
      await visitor.waitForSelector('#me:not([hidden])');
      expect(await visitor.textContent('#me-name')).toBe('Dana');
      expect(await visitor.evaluate(() => localStorage.getItem('sharemd-name'))).toBe('Dana');
      await visitor.waitForSelector('.cm-content'); // the editor loads only after login

      // Reload skips the prompt.
      await visitor.reload();
      await visitor.waitForSelector('#me:not([hidden])');
      expect(await visitor.isVisible('#login-form')).toBe(false);

      // Logout clears the stored name and asks again.
      await visitor.click('#logout');
      await visitor.waitForSelector('#login-form', { state: 'visible' });
      expect(await visitor.evaluate(() => localStorage.getItem('sharemd-name'))).toBeNull();
    } finally {
      await context.close();
    }
  },
  30_000,
);
