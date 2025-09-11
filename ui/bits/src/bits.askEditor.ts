import { frag } from 'lib';
import { licon } from 'lib/licon';
import { domDialog, type Action } from 'lib/view';

type AskTag = {
  key: string;
  label: string;
  title: string;
};

type AskDraft = {
  question: string;
  choices: string[];
  footer: string;
  tags: Set<string>;
};

type AskEditorOpts = {
  textarea: HTMLTextAreaElement;
  range?: RangeInText;
  initial?: AskDraft;
};

type RangeInText = {
  start: number;
  end: number;
};

const tagGroups: { title: string; tags: AskTag[] }[] = [
  {
    title: 'Participation',
    tags: [
      { key: 'open', label: 'Open', title: 'Anyone can participate, even without an account.' },
      { key: 'anon', label: 'Anonymous', title: 'Hide voter identities from the creator and moderators.' },
      { key: 'traceable', label: 'Traceable', title: 'Participants can see who voted for each choice.' },
      { key: 'tally', label: 'Tally', title: 'Show vote totals before the ask is concluded.' },
    ],
  },
  {
    title: 'Choice behavior',
    tags: [
      { key: 'multiple', label: 'Multiple', title: 'Allow participants to choose more than one option.' },
      { key: 'ranked', label: 'Ranked', title: 'Ask participants to drag choices into preference order.' },
      { key: 'random', label: 'Random', title: 'Show choices in a random order for each participant.' },
    ],
  },
  {
    title: 'Layout and form',
    tags: [
      { key: 'vertical', label: 'Vertical', title: 'Show choices one per row.' },
      { key: 'stretch', label: 'Stretch', title: 'Let choices stretch to fill the available width.' },
      { key: 'form', label: 'Form', title: 'Add a short text response field below the choices.' },
    ],
  },
];

export function initModule(opts: AskEditorOpts): Promise<void> {
  return openAskEditor(opts);
}

export default initModule;

export async function openAskEditor(opts: AskEditorOpts): Promise<void> {
  const state: AskDraft = opts.initial ?? {
    question: '',
    choices: ['', ''],
    footer: '',
    tags: new Set(),
  };
  const range = opts.range ?? { start: opts.textarea.selectionStart, end: opts.textarea.selectionEnd };
  const view = makeView(state);

  const update = () => {
    readDraft(view, state);
    enforceTagRules(view, state);
    updateValidation(view, state);
    dialog?.updateActions(actions);
  };

  const actions: Action[] = [
    {
      selector: '.ask-editor__question, .ask-editor__footer, .ask-editor__choice-input',
      event: 'input',
      listener: update,
    },
    { selector: '.ask-editor__tag input', event: 'change', listener: update },
    {
      selector: '.ask-editor__choice-input',
      event: 'keydown',
      listener: e => {
        if ('key' in e && e.key === 'Enter') {
          addChoice(view, '');
          update();
          view.querySelector<HTMLInputElement>('.ask-editor__choice:last-child input')?.focus();
          e.preventDefault();
        }
      },
    },
    {
      selector: '[data-action="add-choice"]',
      listener: () => {
        addChoice(view, '');
        update();
        view.querySelector<HTMLInputElement>('.ask-editor__choice:last-child input')?.focus();
      },
    },
    {
      selector: '[data-action="remove-choice"]',
      listener: e => {
        const row = (e.target as HTMLElement).closest('.ask-editor__choice');
        if (!row || view.querySelectorAll('.ask-editor__choice').length <= 2) return;
        row.remove();
        update();
      },
    },
    { selector: '[data-action="cancel"]', result: 'cancel' },
    {
      selector: '[data-action="ok"]',
      listener: (_, dlg) => {
        readDraft(view, state);
        if (!updateValidation(view, state)) return;
        insertMarkup(opts.textarea, buildMarkup(state), range);
        dlg.close('ok');
      },
    },
  ];

  const dialog = await domDialog({
    class: 'ask-editor-dialog',
    insert: [{ node: view }],
    focus: '.ask-editor__question',
    modal: true,
    actions,
  });
  update();
  await dialog.show();
}

function makeView(state: AskDraft): HTMLElement {
  const view = frag<HTMLElement>($html`
    <div class="ask-editor">
      <h2>Ask poll</h2>
      <label class="ask-editor__field">
        <span>Question</span>
        <input class="ask-editor__question" type="text" maxlength="140" required />
      </label>
      <div class="ask-editor__tag-groups"></div>
      <section class="ask-editor__choices-section">
        <div class="ask-editor__section-head">
          <h3>Choices</h3>
          <button class="button button-empty" type="button" data-action="add-choice" data-icon="${licon.PlusButton}">add</button>
        </div>
        <div class="ask-editor__choices"></div>
      </section>
      <label class="ask-editor__field">
        <span>Footer</span>
        <input class="ask-editor__footer" type="text" maxlength="140" />
      </label>
      <p class="ask-editor__error none"></p>
      <div class="actions">
        <button class="button button-empty button-red" type="button" data-action="cancel">cancel</button>
        <button class="button button-empty ask-editor__ok" type="button" data-action="ok">ok</button>
      </div>
    </div>`);

  view.querySelector<HTMLInputElement>('.ask-editor__question')!.value = state.question;
  view.querySelector<HTMLInputElement>('.ask-editor__footer')!.value = state.footer;
  renderTagGroups(view, state);
  for (const choice of state.choices) addChoice(view, choice);
  return view;
}

function renderTagGroups(view: HTMLElement, state: AskDraft): void {
  const container = view.querySelector<HTMLElement>('.ask-editor__tag-groups')!;
  for (const group of tagGroups) {
    const groupEl = frag<HTMLElement>($html`<fieldset><legend>${group.title}</legend></fieldset>`);
    for (const tag of group.tags) {
      const label = frag<HTMLLabelElement>($html`
        <label class="ask-editor__tag" title="${tag.title}">
          <input type="checkbox" value="${tag.key}" />
          <span>${tag.label}</span>
        </label>`);
      label.querySelector<HTMLInputElement>('input')!.checked = state.tags.has(tag.key);
      groupEl.appendChild(label);
    }
    container.appendChild(groupEl);
  }
}

function addChoice(view: HTMLElement, value: string): void {
  const row = frag<HTMLElement>($html`
    <div class="ask-editor__choice">
      <input class="ask-editor__choice-input" type="text" maxlength="120" />
      <button type="button" title="Remove choice" aria-label="Remove choice" data-action="remove-choice" data-icon="${licon.X}"></button>
    </div>`);
  row.querySelector<HTMLInputElement>('input')!.value = value;
  view.querySelector<HTMLElement>('.ask-editor__choices')!.appendChild(row);
}

function readDraft(view: HTMLElement, state: AskDraft): void {
  state.question = view.querySelector<HTMLInputElement>('.ask-editor__question')!.value.trim();
  state.footer = view.querySelector<HTMLInputElement>('.ask-editor__footer')!.value.trim();
  state.choices = Array.from(view.querySelectorAll<HTMLInputElement>('.ask-editor__choice-input'), i =>
    i.value.trim(),
  );
  state.tags = new Set(
    Array.from(view.querySelectorAll<HTMLInputElement>('.ask-editor__tag input:checked'), i => i.value),
  );
}

function enforceTagRules(view: HTMLElement, state: AskDraft): void {
  if (state.tags.has('ranked')) state.tags.delete('multiple');
  if (state.tags.has('traceable')) state.tags.delete('anon');
  setTagChecked(view, state, 'multiple', !state.tags.has('ranked'));
  setTagChecked(view, state, 'anon', !state.tags.has('traceable'));
}

function setTagChecked(view: HTMLElement, state: AskDraft, key: string, enabled: boolean): void {
  const input = view.querySelector<HTMLInputElement>(`.ask-editor__tag input[value="${key}"]`);
  if (!input) return;
  input.checked = state.tags.has(key);
  input.disabled = !enabled;
  input.closest('label')?.classList.toggle('disabled', !enabled);
}

function updateValidation(view: HTMLElement, state: AskDraft): boolean {
  const error = validationError(state);
  const errorEl = view.querySelector<HTMLElement>('.ask-editor__error')!;
  const ok = view.querySelector<HTMLButtonElement>('.ask-editor__ok')!;
  errorEl.textContent = error ?? '';
  errorEl.classList.toggle('none', !error);
  ok.disabled = !!error;
  ok.classList.toggle('disabled', !!error);
  return !error;
}

function validationError(state: AskDraft): string | undefined {
  if (!state.question) return 'Question is required.';
  const choices = state.choices.filter(Boolean);
  if (choices.length < 2) return 'Add at least two choices.';
  if (choices.some(c => c.startsWith('/') || c.startsWith('?'))) return 'Choices cannot start with / or ?.';
  if (new Set(choices.map(c => c.toLowerCase())).size !== choices.length) return 'Choices must be distinct.';
  return undefined;
}

function buildMarkup(state: AskDraft): string {
  const lines = [`/ask ${state.question}`];
  const tags = orderedTags(state.tags);
  if (tags.length) lines.push(`/${tags.join(' ')}`);
  lines.push(...state.choices.filter(Boolean));
  if (state.footer) lines.push(`? ${state.footer}`);
  return lines.join('\n');
}

function orderedTags(tags: Set<string>): string[] {
  return tagGroups.flatMap(group => group.tags.map(tag => tag.key).filter(tag => tags.has(tag)));
}

function insertMarkup(textarea: HTMLTextAreaElement, markup: string, range: RangeInText): void {
  const before = textarea.value.slice(0, range.start);
  const after = textarea.value.slice(range.end);
  const insert = `${before.endsWith('\n') || !before ? '' : '\n'}${markup}\n${after.startsWith('\n') || !after ? '' : '\n'}`;
  textarea.value = `${before}${insert}${after}`;
  textarea.selectionStart = textarea.selectionEnd = before.length + insert.length;
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
