/**
 * In-app dialogs and toasts — the app's replacement for native prompt() /
 * confirm() / alert(). One reusable overlay (#dialog, same pattern as the
 * #versions overlay) serves text prompts, confirmations and pick-one choices;
 * toasts stack bottom-center and auto-dismiss. Enter confirms, Escape and the
 * backdrop cancel, and the input is focused on open.
 */

const overlay = document.querySelector('#dialog')! as HTMLElement;
const panel = document.querySelector('#dialog-panel')! as HTMLFormElement;
const titleEl = document.querySelector('#dialog-title')!;
const bodyEl = document.querySelector('#dialog-body')! as HTMLElement;
const input = document.querySelector('#dialog-input')! as HTMLInputElement;
const choicesEl = document.querySelector('#dialog-choices')! as HTMLElement;
const cancelButton = document.querySelector('#dialog-cancel')! as HTMLButtonElement;
const confirmButton = document.querySelector('#dialog-confirm')! as HTMLButtonElement;
const tray = document.querySelector('#toast-tray')! as HTMLElement;

/** Resolve the open dialog and tear its wiring down; only one runs at a time. */
let settle: ((value: unknown) => void) | null = null;

function close(result: unknown): void {
  const resolve = settle;
  settle = null;
  overlay.hidden = true;
  bodyEl.hidden = true;
  input.hidden = true;
  choicesEl.hidden = true;
  choicesEl.innerHTML = '';
  confirmButton.hidden = false;
  confirmButton.classList.remove('danger');
  resolve?.(result);
}

// Cancel paths shared by every dialog kind.
cancelButton.addEventListener('click', () => close(null));
overlay.addEventListener('mousedown', (event) => {
  if (event.target === overlay) {
    close(null);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !overlay.hidden) {
    event.preventDefault();
    close(null);
  }
});

interface AskTextOptions {
  title: string;
  hint?: string;
  initial?: string;
  confirmLabel?: string;
}

/** Text prompt. Resolves the trimmed value, or null on cancel / empty input. */
export function askText(options: AskTextOptions): Promise<string | null> {
  return new Promise((resolve) => {
    settle = resolve as (value: unknown) => void;
    titleEl.textContent = options.title;
    bodyEl.textContent = options.hint ?? '';
    bodyEl.hidden = !options.hint;
    input.hidden = false;
    input.value = options.initial ?? '';
    confirmButton.textContent = options.confirmLabel ?? 'OK';
    overlay.hidden = false;
    input.focus();
    input.select();

    panel.onsubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim();
      close(value || null);
    };
  });
}

interface ChoiceOption {
  value: string;
  label: string;
}

interface AskChoiceOptions {
  title: string;
  hint?: string;
  options: ChoiceOption[];
}

/** Pick one of a fixed set of options. Resolves the chosen value, or null. */
export function askChoice(options: AskChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    settle = resolve as (value: unknown) => void;
    titleEl.textContent = options.title;
    bodyEl.textContent = options.hint ?? '';
    bodyEl.hidden = !options.hint;
    choicesEl.hidden = false;
    confirmButton.hidden = true;
    for (const option of options.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dialog-choice';
      button.dataset.value = option.value;
      button.textContent = option.label;
      button.addEventListener('click', () => close(option.value));
      choicesEl.appendChild(button);
    }
    overlay.hidden = false;
    (choicesEl.querySelector('button') as HTMLButtonElement | null)?.focus();

    panel.onsubmit = (event) => event.preventDefault();
  });
}

interface AskConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

/** Yes/no confirmation. Resolves true only if the confirm button is chosen. */
export function askConfirm(options: AskConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    settle = resolve as (value: unknown) => void;
    titleEl.textContent = options.title;
    bodyEl.textContent = options.body ?? '';
    bodyEl.hidden = !options.body;
    confirmButton.textContent = options.confirmLabel ?? 'Confirm';
    confirmButton.classList.toggle('danger', options.danger === true);
    overlay.hidden = false;
    confirmButton.focus();

    panel.onsubmit = (event) => {
      event.preventDefault();
      close(true);
    };
  });
}

export function toast(
  message: string,
  options: { tone?: 'ok' | 'error'; onClick?: () => void } = {},
): void {
  const el = document.createElement('div');
  el.className = `toast toast-${options.tone ?? 'ok'}`;
  el.textContent = message;
  const dismiss = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  if (options.onClick) {
    el.classList.add('clickable');
    el.addEventListener('click', () => {
      options.onClick!();
      dismiss();
    });
  }
  tray.appendChild(el);
  // Force a reflow so the entrance transition runs from the initial state.
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(dismiss, 3000);
}
