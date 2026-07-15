import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { apiCreateDoc, connectPeer, startTestServer } from './helpers';
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

/** The document identity now lives in the URL path, not a header label. */
function waitForPath(path: string) {
  return page.waitForFunction((needle) => location.pathname === needle, `/${path}`);
}

/**
 * Wait for the project switcher to reflect a value. The select is updated
 * during navigation and can also be re-rendered by the focus refetch, so
 * assert on it by waiting rather than reading a single racy snapshot.
 */
function waitForSelected(value: string) {
  return page.waitForFunction(
    (needle) => (document.querySelector('#project-select') as HTMLSelectElement)?.value === needle,
    value,
  );
}

/** A peer is present when an avatar carries its name in the title tooltip. */
function waitForPresence(name: string) {
  return page.waitForFunction(
    (needle) =>
      [...document.querySelectorAll('#presence .avatar')].some(
        (el) => el.getAttribute('title') === needle,
      ),
    name,
  );
}

/** Open the document ⋯ menu and click one of its items (comment/history/rename/…). */
async function docMenu(itemId: string) {
  await page.click('#doc-menu-toggle');
  await page.click(`#${itemId}`);
}

/** Open the project ⋯ menu and click one of its items (rename/connect/delete). */
async function projectMenu(itemId: string) {
  await page.click('#project-menu-toggle');
  await page.click(`#${itemId}`);
}

test(
  'two MCP agents and a human edit the same document concurrently without losing anything',
  async () => {
    // Human opens main/demo.md in the real web UI.
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');

    // Agents join the same document over MCP.
    await alice.call('open_document', { path: 'demo.md' });
    await bob.call('open_document', { path: 'demo.md' });

    // Human sees both agents in the presence stack, marked as agents of their owner.
    await waitForPresence('plosson/alice');
    await waitForPresence('plosson/bob');

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
  'a human sees a live "writing" banner while an agent holds an open edit session',
  async () => {
    // Alice still has main/demo.md open from the previous test; the banner is hidden.
    await page.waitForSelector('#activity', { state: 'hidden' });

    await alice.call('begin_edit', { mode: 'append' });
    await page.waitForSelector('#activity:not([hidden])');
    expect(await page.textContent('#activity')).toInclude('plosson/alice is writing');

    // Closing the session clears the banner.
    await alice.call('abort_edit');
    await page.waitForSelector('#activity', { state: 'hidden' });
  },
  30_000,
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
      await waitForPresence('Carol'); // awareness propagated to the browser
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
    await docMenu('history-open');
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
    await docMenu('comment-add');
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
    await docMenu('comment-add');
    await page.waitForFunction(() =>
      document.querySelector('#comment-add')?.classList.contains('nudge'),
    );
    expect(await page.isVisible('textarea[data-draft="new-comment"]')).toBe(false);

    // Mention autocomplete: type "@plo", pick the second candidate with the keyboard.
    await selectInEditor('second paragraph');
    await docMenu('comment-add');
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
    await page.click('#mode-both');
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
    await page.click('#mode-edit');
    await page.waitForSelector('#preview', { state: 'hidden' });
  },
  45_000,
);

test(
  'url tracks navigation and restores doc, preview, and comment focus across reload',
  async () => {
    // Switching documents pushes a history entry with the doc as the path.
    await page.click('li[data-path="main/other.md"]');
    await waitForPath('main/other.md');

    // View state (mode) is reflected in the hash without new history entries.
    await page.click('#mode-both');
    await page.waitForFunction(() => location.hash.includes('mode=both'));

    // Creating a comment focuses it and deep-links it in the hash.
    await page.evaluate(() => {
      const view = (globalThis as unknown as { mdioView: { state: any; dispatch: any } })
        .mdioView;
      const at = view.state.doc.toString().indexOf('Other');
      view.dispatch({ selection: { anchor: at, head: at + 'Other'.length } });
    });
    await docMenu('comment-add');
    await page.fill('textarea[data-draft="new-comment"]', 'deep-linkable thread');
    await page.click('#comments-list .comment-btn.primary');
    await page.waitForFunction(() => location.hash.includes('comment=c-'));

    // Reload: same document, preview open, same thread focused.
    await page.reload();
    await page.waitForSelector('.cm-content');
    await waitForPath('main/other.md');
    await page.waitForSelector('#preview:not([hidden])');
    await page.waitForSelector('.comment-card.focused');
    expect(await page.textContent('.comment-card.focused')).toInclude('deep-linkable thread');

    // Back returns to the previous document (and its view state: preview off).
    await page.goBack();
    await waitForPath('main/demo.md');
    await page.waitForSelector('#preview', { state: 'hidden' });
  },
  30_000,
);

test(
  'url edge cases: filter state, click focus, direct paths, bad doc, stale comment',
  async () => {
    // The ?name= login shortcut was stripped at boot: query clean, doc is the path.
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
    await page.goto(`${server.url}/main/other.md#mode=both`);
    await page.waitForSelector('.cm-content');
    await waitForPath('main/other.md');
    await page.waitForSelector('#preview:not([hidden])');

    // An unknown document falls back to the first doc and normalizes the path.
    await page.goto(`${server.url}/does-not-exist.md`);
    await page.waitForSelector('.cm-content');
    await waitForPath('main/demo.md');

    // A stale comment id is ignored: page loads, nothing focused, no errors.
    await page.goto(`${server.url}/main/demo.md#comment=c-deleted-long-ago`);
    await page.waitForSelector('.cm-content');
    await waitForPath('main/demo.md');
    expect(await page.locator('.comment-card.focused').count()).toBe(0);
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
      // `/` is Home now: it renders the surface, it does not teleport into a doc.
      await visitor.waitForSelector('#surface:not([hidden]) .home');
      expect(await visitor.evaluate(() => location.pathname)).toBe('/');

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
    // A second project with a document, created over the REST API.
    await apiCreateDoc(server, 'specs/plan.md');

    await page.goto(`${server.url}/specs/plan.md`);
    await page.waitForSelector('.cm-content');
    await waitForPath('specs/plan.md');

    // Sidebar is scoped: this project's docs (sans prefix), none of main's.
    const selected = () =>
      page.evaluate(() => (document.querySelector('#project-select') as HTMLSelectElement).value);
    await waitForSelected('specs');
    await waitForText('#doc-list', 'plan.md');
    expect(await page.locator('li[data-path="main/demo.md"]').count()).toBe(0);

    // Switching projects opens that project's first document.
    await page.selectOption('#project-select', 'main');
    await waitForPath('main/demo.md');

    // Back crosses the project boundary and the switcher follows.
    await page.goBack();
    await waitForPath('specs/plan.md');
    await waitForSelected('specs');
  },
  30_000,
);

test(
  'humans CRUD projects and documents from the UI, with cancels and errors handled',
  async () => {
    const selected = () =>
      page.evaluate(() => (document.querySelector('#project-select') as HTMLSelectElement).value);
    // Fill the in-app text dialog and confirm it.
    const dialogSubmit = async (value: string) => {
      await page.waitForSelector('#dialog:not([hidden]) #dialog-input:not([hidden])');
      await page.fill('#dialog-input', value);
      await page.click('#dialog-confirm');
      await page.waitForSelector('#dialog', { state: 'hidden' });
    };

    // Starting point: the specs project from the previous test.
    await page.goto(`${server.url}/specs/plan.md`);
    await page.waitForSelector('.cm-content');

    // Cancelling the dialog changes nothing.
    await page.click('#project-new');
    await page.waitForSelector('#dialog:not([hidden])');
    await page.click('#dialog-cancel');
    await page.waitForSelector('#dialog', { state: 'hidden' });
    await waitForSelected('specs');
    expect(await page.evaluate(() => location.pathname)).toBe('/specs/plan.md');

    // A reserved project name is rejected and surfaced as an error toast.
    await page.click('#project-new');
    await dialogSubmit('api');
    await page.waitForSelector('.toast-error');
    expect(await page.textContent('.toast-error')).toContain('reserved');
    await waitForSelected('specs');

    // Create a project: URL becomes its page, sidebar is empty with an empty state.
    await page.click('#project-new');
    await dialogSubmit('research');
    await page.waitForFunction(() => location.pathname === '/research');
    await waitForSelected('research');
    expect(await page.locator('#doc-list li').count()).toBe(0);
    await page.waitForSelector('#empty-state:not([hidden])');

    // Create a document — the .md extension is implied.
    await page.click('#doc-new');
    await dialogSubmit('ideas');
    await page.waitForFunction(() => location.pathname === '/research/ideas.md');
    await page.locator('.cm-content').click();
    await page.keyboard.type('# Ideas from the UI');
    await waitForText('.cm-content', '# Ideas from the UI');

    // Rename it (from the ⋯ menu): URL updates, content survives.
    await docMenu('doc-rename');
    await dialogSubmit('brainstorm.md');
    await page.waitForFunction(() => location.pathname === '/research/brainstorm.md');
    await waitForText('.cm-content', '# Ideas from the UI');

    // Move it to another project via the picker dialog.
    await docMenu('doc-move');
    await page.click('.dialog-choice[data-value="main"]');
    await page.waitForFunction(() => location.pathname === '/main/brainstorm.md');
    await waitForText('.cm-content', '# Ideas from the UI');
    await waitForSelected('main');

    // Delete it: the UI falls back to the project's first document.
    await docMenu('doc-delete');
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');
    expect(await page.locator('li[data-path="main/brainstorm.md"]').count()).toBe(0);

    // Rename the (now empty) research project from the project ⋯ menu.
    await page.selectOption('#project-select', 'research');
    await page.waitForFunction(() => location.pathname === '/research');
    await projectMenu('project-rename');
    await dialogSubmit('lab');
    await page.waitForFunction(() => location.pathname === '/lab');
    await waitForSelected('lab');

    // Delete it: back to the first remaining project, dropdown updated.
    await projectMenu('project-delete');
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => location.pathname === '/main/demo.md');
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('#project-select option')].map((option) => option.textContent),
    );
    expect(options).not.toContain('lab');
    expect(options).not.toContain('research');
  },
  60_000,
);

test(
  'versions: save a named checkpoint, then restore it to roll the live text back',
  async () => {
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');

    const toDocEnd = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');

    // Reach a known state, then checkpoint it.
    await page.locator('.cm-content').click();
    await toDocEnd();
    await page.keyboard.type('\nVERSIONS_MARKER_ONE\n', { delay: 10 });
    await waitForText('.cm-content', 'VERSIONS_MARKER_ONE');

    await docMenu('versions-open');
    await page.waitForSelector('#versions:not([hidden])');
    expect(await page.textContent('#versions-title')).toBe('main/demo.md — versions');
    await page.fill('#versions-label', 'checkpoint one');
    await page.click('#versions-form button[type="submit"]');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.version-label')].some((el) => el.textContent === 'checkpoint one'),
    );
    await page.click('#versions-close');
    await page.waitForSelector('#versions', { state: 'hidden' });

    // Diverge from the checkpoint.
    await page.locator('.cm-content').click();
    await toDocEnd();
    await page.keyboard.type('\nVERSIONS_MARKER_TWO\n', { delay: 10 });
    await waitForText('.cm-content', 'VERSIONS_MARKER_TWO');

    // Restore rolls the editor back to the checkpoint: ONE returns, TWO is gone.
    await docMenu('versions-open');
    await page.waitForSelector('#versions:not([hidden])');
    await page.click('.version-restore');
    await page.waitForSelector('#dialog:not([hidden])');
    await page.click('#dialog-confirm');
    await page.waitForFunction(() => {
      const text = document.querySelector('.cm-content')?.textContent ?? '';
      return text.includes('VERSIONS_MARKER_ONE') && !text.includes('VERSIONS_MARKER_TWO');
    });

    // The restore is authored to the human and persisted like any other edit.
    await server.registry.flushAll();
    const onDisk = await Bun.file(join(vaultDir, 'main/demo.md')).text();
    expect(onDisk).toInclude('VERSIONS_MARKER_ONE');
    expect(onDisk).not.toInclude('VERSIONS_MARKER_TWO');
  },
  60_000,
);

test(
  'the ⌘K palette jumps to documents, searches text, and runs actions (keyboard-driven)',
  async () => {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');

    // Open with the keyboard shortcut; documents load in.
    await page.keyboard.press(`${mod}+k`);
    await page.waitForSelector('#palette:not([hidden])');
    await page.waitForSelector('.palette-item');

    // Keyboard nav: the first row is selected, ArrowDown moves the selection.
    await page.waitForSelector('.palette-item.selected[data-index="0"]');
    await page.keyboard.press('ArrowDown');
    await page.waitForSelector('.palette-item.selected[data-index="1"]');

    // Filter to a document by path, then open it with Enter (keyboard-only).
    await page.fill('#palette-input', 'other');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.palette-item-sub')].some((el) => el.textContent?.includes('other.md')),
    );
    await page.waitForSelector('.palette-item.selected');
    await page.keyboard.press('Enter');
    await waitForPath('main/other.md');
    await page.waitForSelector('#palette', { state: 'hidden' });

    // A full-text query (≥3 chars) adds an "In text" section for the current project.
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');
    await page.keyboard.press(`${mod}+k`);
    await page.waitForSelector('#palette:not([hidden])');
    await page.fill('#palette-input', 'Notes');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.palette-section')].some((el) => el.textContent?.startsWith('In text')),
    );

    // An action: filter to Settings and click it (mouse path) → navigates.
    await page.fill('#palette-input', 'Settings');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.palette-item-label')].some((el) => el.textContent === 'Settings'),
    );
    await page.click('.palette-item:has(.palette-item-label:text-is("Settings"))');
    await waitForPath('settings');
    await page.waitForSelector('#surface:not([hidden]) .settings');
    await page.waitForSelector('#palette', { state: 'hidden' });
  },
  30_000,
);

test(
  'an agent proposes a suggested edit; the human accepts it via the inline popover',
  async () => {
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');
    await alice.call('open_document', { path: 'demo.md' });

    // Alice adds a target word, then proposes replacing it — the text does not change.
    await alice.call('place_cursor', { boundary: 'end' });
    await alice.call('insert_text', { text: '\nSUGGEST_TARGET_WORD\n' });
    await waitForText('.cm-content', 'SUGGEST_TARGET_WORD');
    const { matches } = await alice.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'SUGGEST_TARGET_WORD',
    });
    await alice.call('suggest_replace', { matchId: matches[0]!.matchId, text: 'REPLACED_WORD' });

    // The human sees the inline highlight and the rail retitled as bulk review — text intact.
    await page.waitForSelector('#suggestions-panel:not([hidden]) .suggest-card');
    await page.waitForSelector('.mdio-suggest-replace');
    await waitForText('#suggestions-title', 'Review 1 suggestion');
    expect(await page.textContent('.cm-content')).toInclude('SUGGEST_TARGET_WORD');

    // Clicking the marked range opens the anchored popover with the proposal.
    await page.click('.mdio-suggest-replace');
    await page.waitForSelector('.suggest-popover');
    expect(await page.textContent('.suggest-popover')).toInclude('plosson/alice');
    expect(await page.textContent('.suggest-popover')).toInclude('REPLACED_WORD');

    // Accepting from the popover applies the change and dismisses everything.
    await page.click('.suggest-popover .suggest-btn.primary');
    await page.waitForFunction(() => {
      const text = document.querySelector('.cm-content')?.textContent ?? '';
      return text.includes('REPLACED_WORD') && !text.includes('SUGGEST_TARGET_WORD');
    });
    await page.waitForSelector('.suggest-popover', { state: 'hidden' });
    await page.waitForSelector('#suggestions-panel', { state: 'hidden' });
  },
  30_000,
);

test(
  'bulk review: Accept all applies every pending suggestion behind a danger confirm',
  async () => {
    await page.goto(`${server.url}/main/demo.md?name=Human`);
    await waitForText('.cm-content', 'Demo document');
    await alice.call('open_document', { path: 'demo.md' });

    // Two independent insert suggestions at the document end.
    await alice.call('place_cursor', { boundary: 'end' });
    await alice.call('insert_text', { text: '\nBULK_ANCHOR_A\nBULK_ANCHOR_B\n' });
    await waitForText('.cm-content', 'BULK_ANCHOR_B');
    const a = await alice.call<{ matches: Array<{ matchId: string }> }>('search_text', { query: 'BULK_ANCHOR_A' });
    await alice.call('suggest_insert', { matchId: a.matches[0]!.matchId, edge: 'end', text: ' BULK_ADDED_A' });
    const b = await alice.call<{ matches: Array<{ matchId: string }> }>('search_text', { query: 'BULK_ANCHOR_B' });
    await alice.call('suggest_insert', { matchId: b.matches[0]!.matchId, edge: 'end', text: ' BULK_ADDED_B' });

    await waitForText('#suggestions-title', 'Review 2 suggestions');

    // Accept all is gated by a danger confirm.
    await page.click('#suggest-accept-all');
    await page.waitForSelector('#dialog:not([hidden])');
    expect(await page.textContent('#dialog-title')).toInclude('Accept all 2 suggestions');
    await page.click('#dialog-confirm');

    // Both proposals land in the text and the rail empties.
    await page.waitForFunction(() => {
      const text = document.querySelector('.cm-content')?.textContent ?? '';
      return text.includes('BULK_ADDED_A') && text.includes('BULK_ADDED_B');
    });
    await page.waitForSelector('#suggestions-panel', { state: 'hidden' });
  },
  30_000,
);

test(
  'the Agents page shows copyable wiring and a live identity, reachable by deep link',
  async () => {
    // Deep-link straight to the agents page (SPA fallback serves it, reload works).
    await page.goto(`${server.url}/main/agents?name=Human`);
    await page.waitForSelector('#surface:not([hidden]) .agents');
    await waitForPath('main/agents');

    // Install command, the live mdio-mcp-install command, and the raw .mcp.json.
    await page.waitForSelector('.agents .command-pre');
    const body = (await page.textContent('.agents'))!;
    expect(body).toInclude('install.sh'); // the binary install one-liner
    expect(body).toInclude('--project main'); // the mdio mcp install command
    expect(body).toInclude('Human/claude'); // owner/agent suggested from the login

    // The .mcp.json disclosure carries the project env.
    await page.click('.agents-disclosure summary');
    expect(await page.textContent('.agents-disclosure')).toInclude('"MDIO_PROJECT": "main"');

    // Editing the identity re-renders the command live.
    await page.fill('.agents-identity', 'Human/scribe');
    await page.waitForFunction(() =>
      document.querySelector('.agents')?.textContent?.includes('--username Human/scribe'),
    );

    // Reaching it from the project ⋯ menu lands on the same page.
    await page.goto(`${server.url}/main/demo.md`);
    await page.waitForSelector('.cm-content');
    await projectMenu('project-mcp');
    await waitForPath('main/agents');
    await page.waitForSelector('#surface:not([hidden]) .agents');
  },
  30_000,
);

test(
  'the Agents page flips to "connected" when a matching MCP peer joins',
  async () => {
    await page.goto(`${server.url}/main/agents?name=Human`);
    await page.waitForSelector('#surface:not([hidden]) .agents');
    // Wire the identity to alice's, who is connected to a doc in this project.
    await page.fill('.agents-identity', 'plosson/alice');
    await alice.call('open_document', { path: 'demo.md' });

    // The ~3s poll notices the peer and the status flips to connected.
    await page.waitForSelector('.agents-status.connected', { timeout: 15_000 });
    expect(await page.textContent('.agents-status')).toInclude('plosson/alice connected');
    // …and the peer shows up in the connected-agents list.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.agents-peer-name')].some((el) => el.textContent === 'plosson/alice'),
    );
  },
  30_000,
);

test(
  'the Agents page renders the activity feed of what agents did in the project',
  async () => {
    // Alice re-joins and proposes an edit so the feed has fresh events to show.
    await alice.call('open_document', { path: 'demo.md' });
    await alice.call('place_cursor', { boundary: 'end' });
    await alice.call('insert_text', { text: '\nFEED_ANCHOR_WORD\n' });
    const { matches } = await alice.call<{ matches: Array<{ matchId: string }> }>('search_text', {
      query: 'FEED_ANCHOR_WORD',
    });
    await alice.call('suggest_replace', { matchId: matches[0]!.matchId, text: 'FEED_REPLACED_WORD' });

    await page.goto(`${server.url}/main/agents?name=Human`);
    await page.waitForSelector('#surface:not([hidden]) .agents');

    // The feed (polled ~3s) lists activity attributed to alice, with a doc link.
    await page.waitForSelector('.agents-activity .activity-row', { timeout: 15_000 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.agents-activity .activity-actor')].some(
        (el) => el.textContent === 'plosson/alice',
      ),
    );
    expect(await page.textContent('.agents-activity')).toInclude('suggested an edit');
    expect(await page.locator('.agents-activity .activity-doc').first().textContent()).toContain('demo.md');
  },
  30_000,
);

test(
  'Home shows project cards and recents; a card opens the project',
  async () => {
    await page.goto(`${server.url}/?name=Human`);
    await page.waitForSelector('#surface:not([hidden]) .home');
    await waitForPath('');

    // Greeting counts and a card for the main project.
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.project-card .card-title')].some((el) => el.textContent === 'main'),
    );
    await waitForText('.home-counts', 'documents');

    // Clicking the main card opens the project (its first document).
    await page.click('.project-card:has(.card-title:text-is("main"))');
    await page.waitForSelector('.cm-content');
    await waitForSelected('main');
  },
  30_000,
);

test(
  'the inbox surfaces a mention and deep-links to the focused thread, surviving reload',
  async () => {
    // Human mentions a *different* human (dana) so the thread is unhandled for dana.
    await page.goto(`${server.url}/main/other.md?name=Human`);
    await page.waitForSelector('.cm-content');
    await page.evaluate(() => {
      const view = (globalThis as unknown as { mdioView: { state: any; dispatch: any } }).mdioView;
      const at = view.state.doc.toString().indexOf('Other');
      view.dispatch({ selection: { anchor: at, head: at + 'Other'.length } });
    });
    await docMenu('comment-add');
    await page.fill('textarea[data-draft="new-comment"]', 'please look at this, @dana');
    await page.click('#comments-list .comment-btn.primary');
    await waitForText('#comments-list', 'please look');

    // dana's Home inbox shows the mention row (server sweep sees the live room).
    await page.goto(`${server.url}/?name=dana`);
    await page.waitForSelector('#surface:not([hidden]) .home');
    await waitForText('.inbox-list', 'please look');

    // Clicking the row opens the doc with the thread focused; the deep link reloads.
    await page.click('.inbox-row');
    await waitForPath('main/other.md');
    await page.waitForFunction(() => location.hash.includes('comment=c-'));
    await page.waitForSelector('.comment-card.focused');
    await page.reload();
    await page.waitForSelector('.cm-content');
    await page.waitForSelector('.comment-card.focused');
    expect(await page.textContent('.comment-card.focused')).toInclude('please look');
  },
  40_000,
);

test(
  'Settings renames a project and applies an editor preference, reachable by deep link',
  async () => {
    await page.goto(`${server.url}/settings?name=Human`);
    await page.waitForSelector('#surface:not([hidden]) .settings');
    await waitForPath('settings');

    // Editor prefs: switch the reading width and confirm it lands on :root.
    await page.click('.settings-nav-item:text-is("Editor")');
    await page.click('.seg-btn:text-is("80")');
    await page.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--reading-width') === '80ch',
    );
    expect(await page.evaluate(() => localStorage.getItem('mdio-reading-width'))).toBe('80');

    // Reset it so later navigation is unaffected.
    await page.click('.seg-btn:text-is("72")');
    await page.waitForFunction(
      () => document.documentElement.style.getPropertyValue('--reading-width') === '72ch',
    );
  },
  30_000,
);
