import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { connectPeer, startTestServer, waitFor } from './helpers';
import type { MdioServer } from '../src/server/index';
import { AgentClient } from './mcp-client';

let server: MdioServer;
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
    // Human opens main/demo.md in the real web UI.
    await page.goto(`${server.url}/?name=Human&doc=main/demo.md`);
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
      // Jump to document start: Cmd+Up on macOS, Ctrl+Home elsewhere (Ctrl+Up is
      // not a doc-start motion on Linux — the human would type inside Alice's stream).
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
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
    const onDisk = await Bun.file(join(vaultDir, 'main/demo.md')).text();
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
    const carol = await connectPeer(server, 'main/demo.md');
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
          [...document.querySelectorAll('.mdio-edit-badge')].some((el) =>
            el.textContent?.includes('Carol'),
          ) && document.querySelectorAll('.mdio-remote-edit').length > 0,
        undefined,
        { timeout: 5000 },
      );

      // …and the highlight is transient: gone shortly after.
      await page.waitForFunction(
        () => document.querySelectorAll('.mdio-edit-badge').length === 0,
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
    expect(await page.textContent('#history-title')).toBe('main/demo.md — history');

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
  'comments: human comments a selection, agent replies and resolves, browser follows live',
  async () => {
    // Human selects "First note" and opens a comment thread on it.
    await page.evaluate(() => {
      const view = (globalThis as unknown as { mdioView: { state: any; dispatch: any } })
        .mdioView;
      const at = view.state.doc.toString().indexOf('First note');
      view.dispatch({ selection: { anchor: at, head: at + 'First note'.length } });
    });
    await page.click('#comment-add');
    await page.fill(
      '#comments-list textarea[data-draft="new-comment"]',
      'HUMAN: is this note still valid, @plosson/alice?',
    );
    await page.click('#comments-list .comment-btn.primary');
    await page.waitForSelector('.mdio-comment'); // range highlighted in the editor
    await waitForText('#comments-list', 'is this note still valid');

    // The agent finds the thread by mention, replies, then resolves it.
    let rootId = '';
    for (let attempt = 0; attempt < 40 && !rootId; attempt++) {
      const { threads } = await alice.call<{
        threads: Array<{ root: { id: string }; currentText: string | null }>;
      }>('list_comments', { mentioning: 'plosson/alice' });
      if (threads.length > 0) {
        rootId = threads[0]!.root.id;
        expect(threads[0]!.currentText).toBe('First note');
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(rootId).not.toBe('');

    await alice.call('reply_comment', { commentId: rootId, body: 'still valid, checked @Human' });
    await waitForText('#comments-list', 'still valid, checked');

    await alice.call('resolve_comment', { commentId: rootId });
    // Resolved: highlight gone, thread hidden behind the "show resolved" filter.
    await page.waitForFunction(
      () => document.querySelectorAll('.mdio-comment').length === 0,
      undefined,
      { timeout: 5000 },
    );
    await waitForText('#comments-list', 'resolved thread hidden');
    await page.check('#comments-show-resolved');
    await waitForText('#comments-list', 'is this note still valid');
    await waitForText('#comments-list .comment-card.resolved', 'Reopen');
  },
  30_000,
);

test(
  'browser comment interactions: nudge, mention autocomplete, reply, edit, focus, orphan, delete',
  async () => {
    const selectInEditor = (needle: string, collapse = false) =>
      page.evaluate(
        ({ text, empty }) => {
          const view = (globalThis as unknown as { mdioView: { state: any; dispatch: any } })
            .mdioView;
          const at = view.state.doc.toString().indexOf(text);
          view.dispatch({ selection: { anchor: at, head: empty ? at : at + text.length } });
        },
        { text: needle, empty: collapse },
      );

    // Empty selection: the add button nudges instead of opening a composer.
    await selectInEditor('ALICE: second paragraph', true);
    await page.click('#comment-add');
    await page.waitForFunction(() =>
      document.querySelector('#comment-add')?.classList.contains('nudge'),
    );
    expect(await page.isVisible('textarea[data-draft="new-comment"]')).toBe(false);

    // Mention autocomplete: type "@plo", pick the second candidate with the keyboard.
    await selectInEditor('second paragraph');
    await page.click('#comment-add');
    await page.fill('textarea[data-draft="new-comment"]', 'needs polish @plo');
    await page.waitForSelector('.mention-dropdown:not([hidden]) .mention-option');
    const options = await page.locator('.mention-option').allTextContents();
    expect(options).toEqual(['@plosson/alice', '@plosson/bob']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await page.inputValue('textarea[data-draft="new-comment"]')).toBe(
      'needs polish @plosson/bob ',
    );
    await page.click('#comments-list .comment-btn.primary');
    await waitForText('#comments-list', 'needs polish');
    expect(await page.textContent('.comment-card:not(.resolved) .comment-mention')).toBe(
      '@plosson/bob',
    );

    // Browser-side reply on the open thread.
    await page.fill('.comment-card:not(.resolved) textarea[data-draft^="reply:"]', 'on it');
    await page.click('.comment-card:not(.resolved) .comment-reply .comment-btn.primary');
    await waitForText('#comments-list', 'on it');

    // Edit own root comment.
    await page.click('.comment-card:not(.resolved) .comment-entry:not(.reply) .comment-btn.subtle');
    await page.fill('.comment-card:not(.resolved) textarea[data-draft^="edit:"]', 'polish DONE');
    await page.click('.comment-card:not(.resolved) .comment-compose .comment-btn.primary');
    await waitForText('#comments-list', 'polish DONE');
    await waitForText('#comments-list', '(edited)');

    // Clicking the highlight in the editor focuses the thread card.
    await page.click('.mdio-comment');
    await page.waitForSelector('.comment-card.focused');
    expect(await page.textContent('.comment-card.focused')).toInclude('polish DONE');

    // An agent rewriting the commented text orphans the thread, visibly.
    await alice.call('replace_text', {
      query: 'ALICE: second paragraph, streamed.',
      replacement: 'ALICE: rewritten paragraph.',
    });
    await waitForText('#comments-list', '(original text deleted)');
    await page.waitForFunction(() => document.querySelectorAll('.mdio-comment').length === 0);

    // Delete the reply, then the root — thread disappears entirely.
    const deleteButtons = page.locator(
      '.comment-card:not(.resolved) .comment-entry.reply .comment-btn.subtle >> text=delete',
    );
    await deleteButtons.click();
    await page.waitForFunction(
      () => !document.querySelector('#comments-list')?.textContent?.includes('on it'),
    );
    await page.click(
      '.comment-card:not(.resolved) .comment-entry:not(.reply) .comment-btn.subtle >> text=delete',
    );
    await page.waitForFunction(
      () => !document.querySelector('#comments-list')?.textContent?.includes('polish DONE'),
    );
  },
  30_000,
);

test(
  'markdown preview renders live, including mermaid diagrams (and survives invalid ones)',
  async () => {
    await page.click('#preview-toggle');
    await page.waitForSelector('#preview:not([hidden])');
    await page.waitForFunction(() =>
      document.querySelector('#preview h1')?.textContent?.includes('Demo document'),
    );

    // An agent appends a mermaid diagram; the preview picks it up live.
    await alice.call('begin_edit', { mode: 'append' });
    await alice.call('append_text', {
      text: '\n```mermaid\ngraph TD\n  Server --> Browser\n  Server --> Agent\n```\n',
    });
    await alice.call('commit_edit');
    await page.waitForFunction(
      () => document.querySelector('#preview pre.mermaid svg') !== null,
      undefined,
      { timeout: 15_000 },
    );

    // An invalid diagram is flagged in place without breaking the valid one.
    await alice.call('begin_edit', { mode: 'append' });
    await alice.call('append_text', { text: '\n```mermaid\nthis is !! not a diagram ??\n```\n' });
    await alice.call('commit_edit');
    await page.waitForFunction(
      () => document.querySelector('#preview pre.mermaid.mermaid-error') !== null,
      undefined,
      { timeout: 15_000 },
    );
    expect(await page.locator('#preview pre.mermaid svg').count()).toBeGreaterThanOrEqual(1);

    // Leave the pane off so later tests see the default layout.
    await page.click('#preview-toggle');
    await page.waitForSelector('#preview', { state: 'hidden' });
  },
  45_000,
);

test(
  'url tracks navigation and restores doc, preview, and comment focus across reload',
  async () => {
    // Switching documents pushes a history entry with the doc as the path.
    await page.click('li[data-path="main/other.md"]');
    await waitForText('#doc-title', 'main/other.md');
    await page.waitForFunction(() => location.pathname === '/main/other.md');

    // View state (preview) is reflected in the hash without new history entries.
    await page.click('#preview-toggle');
    await page.waitForFunction(() => location.hash.includes('preview=1'));

    // Creating a comment focuses it and deep-links it in the hash.
    await page.evaluate(() => {
      const view = (globalThis as unknown as { mdioView: { state: any; dispatch: any } })
        .mdioView;
      const at = view.state.doc.toString().indexOf('Other');
      view.dispatch({ selection: { anchor: at, head: at + 'Other'.length } });
    });
    await page.click('#comment-add');
    await page.fill('textarea[data-draft="new-comment"]', 'deep-linkable thread');
    await page.click('#comments-list .comment-btn.primary');
    await page.waitForFunction(() => location.hash.includes('comment=c-'));

    // Reload: same document, preview open, same thread focused.
    await page.reload();
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'main/other.md');
    await page.waitForSelector('#preview:not([hidden])');
    await page.waitForSelector('.comment-card.focused');
    expect(await page.textContent('.comment-card.focused')).toInclude('deep-linkable thread');

    // Back returns to the previous document (and its view state: preview off).
    await page.goBack();
    await waitForText('#doc-title', 'main/demo.md');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');
    await page.waitForSelector('#preview', { state: 'hidden' });
  },
  30_000,
);

test(
  'url edge cases: filter state, click focus, direct paths, bad doc, stale comment, legacy links',
  async () => {
    // Legacy ?doc= was migrated into the path at boot: query is clean, doc is the path.
    expect(await page.evaluate(() => location.search)).toBe('');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');

    // The resolved filter round-trips: checkbox → hash → reload.
    await page.check('#comments-show-resolved');
    await page.waitForFunction(() => location.hash.includes('resolved=1'));
    await waitForText('#comments-list', 'is this note still valid'); // the resolved thread
    await page.reload();
    await page.waitForSelector('.cm-content');
    expect(await page.isChecked('#comments-show-resolved')).toBe(true);
    await waitForText('#comments-list', 'is this note still valid');

    // Clicking a thread card focuses it and deep-links it.
    await page.click('.comment-card');
    await page.waitForFunction(() => location.hash.includes('comment=c-'));
    await page.waitForSelector('.comment-card.focused');

    // A direct path URL loads that document with its view state applied.
    await page.goto(`${server.url}/main/other.md#preview=1`);
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'main/other.md');
    await page.waitForSelector('#preview:not([hidden])');

    // An unknown document falls back to the first doc and normalizes the path.
    await page.goto(`${server.url}/does-not-exist.md`);
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'main/demo.md');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');

    // Legacy hash links (#doc=…) still resolve, and normalize to the path form.
    // A stale comment id is ignored: page loads, nothing focused, no errors.
    await page.goto(`${server.url}/#doc=main/demo.md&comment=c-deleted-long-ago`);
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'main/demo.md');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');
    expect(await page.locator('.comment-card.focused').count()).toBe(0);

    // Pre-projects links name root docs that were migrated into the default project.
    await page.goto(`${server.url}/#doc=demo.md`);
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'main/demo.md');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');
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
      expect(await visitor.evaluate(() => localStorage.getItem('mdio-name'))).toBe('Dana');
      await visitor.waitForSelector('.cm-content'); // the editor loads only after login

      // Reload skips the prompt.
      await visitor.reload();
      await visitor.waitForSelector('#me:not([hidden])');
      expect(await visitor.isVisible('#login-form')).toBe(false);

      // Logout clears the stored name and asks again.
      await visitor.click('#logout');
      await visitor.waitForSelector('#login-form', { state: 'visible' });
      expect(await visitor.evaluate(() => localStorage.getItem('mdio-name'))).toBeNull();
    } finally {
      await context.close();
    }
  },
  30_000,
);

test(
  'projects: the sidebar is scoped to one project and the switcher navigates between them',
  async () => {
    // A second project springs into existence when a peer edits a doc in it.
    const writer = await connectPeer(server, 'specs/plan.md');
    writer.text.insert(0, '# Plan\n\nSpec things.\n');
    const room = await server.registry.open('specs/plan.md');
    await waitFor(() => room.doc.getText('content').toString().includes('# Plan'), {
      label: 'server room to receive the edit',
    });
    writer.destroy();
    await server.registry.flushAll(); // the project dir exists once the doc persists

    await page.goto(`${server.url}/specs/plan.md`);
    await page.waitForSelector('.cm-content');
    await waitForText('#doc-title', 'specs/plan.md');

    // Sidebar is scoped: this project's docs (sans prefix), none of main's.
    const selected = () =>
      page.evaluate(() => (document.querySelector('#project-select') as HTMLSelectElement).value);
    expect(await selected()).toBe('specs');
    await waitForText('#doc-list', 'plan.md');
    expect(await page.locator('li[data-path="main/demo.md"]').count()).toBe(0);

    // Switching projects opens that project's first document.
    await page.selectOption('#project-select', 'main');
    await waitForText('#doc-title', 'main/demo.md');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');

    // Back crosses the project boundary and the switcher follows.
    await page.goBack();
    await waitForText('#doc-title', 'specs/plan.md');
    await page.waitForFunction(() => location.pathname === '/specs/plan.md');
    expect(await selected()).toBe('specs');
  },
  30_000,
);
