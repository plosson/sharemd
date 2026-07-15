import { createSnapshot, listSnapshots, restoreSnapshot, type Snapshot } from './api';
import { askConfirm, toast } from './dialogs';

/**
 * Versions overlay: save named checkpoints of a document and restore any of
 * them. Restore converges the live text back to the captured version as an
 * authored, reversible edit (server-side) — it does not reset CRDT state, so
 * other peers just see the text change.
 */

const listEl = document.querySelector('#versions-list')!;
const form = document.querySelector('#versions-form')! as HTMLFormElement;
const labelInput = document.querySelector('#versions-label')! as HTMLInputElement;
const saveButton = document.querySelector('#versions-save')! as HTMLButtonElement;

let ctx: { path: string; author: string } | null = null;

async function refresh(): Promise<void> {
  if (!ctx) {
    return;
  }
  const snapshots = await listSnapshots(ctx.path);
  listEl.innerHTML = '';
  if (snapshots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'versions-empty';
    empty.textContent = 'No saved versions yet — save one above to checkpoint the document.';
    listEl.appendChild(empty);
    return;
  }
  // Newest first — most recent checkpoint is the one people reach for.
  for (const snapshot of [...snapshots].reverse()) {
    const row = document.createElement('div');
    row.className = 'version-row';

    const meta = document.createElement('div');
    meta.className = 'version-meta';
    const label = document.createElement('span');
    label.className = 'version-label';
    label.textContent = snapshot.label;
    const sub = document.createElement('span');
    sub.className = 'version-sub';
    sub.textContent = `${snapshot.author || 'unknown'} · ${new Date(snapshot.ts).toLocaleString()}`;
    meta.append(label, sub);

    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'version-restore';
    restore.textContent = 'restore';
    restore.addEventListener('click', () => void doRestore(snapshot));

    row.append(meta, restore);
    listEl.appendChild(row);
  }
}

async function doRestore(snapshot: Snapshot): Promise<void> {
  if (!ctx) {
    return;
  }
  const ok = await askConfirm({
    title: `Restore “${snapshot.label}”?`,
    body:
      'The current text is replaced with that version. This is itself a normal ' +
      'edit, so you can undo it or restore a newer version.',
    confirmLabel: 'Restore',
  });
  if (!ok) {
    return;
  }
  try {
    await restoreSnapshot(ctx.path, snapshot.id, ctx.author);
    toast(`Restored “${snapshot.label}”`);
    await refresh();
  } catch (error) {
    toast(`Restore failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'error' });
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ctx) {
    return;
  }
  const label = labelInput.value.trim();
  if (!label) {
    return;
  }
  const { path, author } = ctx;
  void (async () => {
    saveButton.disabled = true;
    try {
      await createSnapshot(path, label, author);
      labelInput.value = '';
      await refresh();
      toast(`Saved “${label}”`);
    } catch (error) {
      toast(`Save failed: ${error instanceof Error ? error.message : String(error)}`, { tone: 'error' });
    } finally {
      saveButton.disabled = false;
    }
  })();
});

export function closeVersions(): void {
  ctx = null;
}

/**
 * Load a document's named versions into the Versions tab of the shared drawer.
 * The drawer owns visibility and the close affordance; this only fills the pane.
 */
export async function openVersions(path: string, author: string): Promise<void> {
  ctx = { path, author };
  labelInput.value = '';
  await refresh();
}
