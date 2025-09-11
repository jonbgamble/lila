import { frag } from 'lib';
import { throttle } from 'lib/async';
import { isTouchDevice } from 'lib/device';
import { textRaw as xhrTextRaw, form as xhrForm, ensureOk } from 'lib/xhr';

export default function initModule(): void {
  // normal ui
  for (const askContainer of document.querySelectorAll<HTMLElement>('.ask-container')) {
    new Ask(askContainer.firstElementChild as HTMLElement);
  }
  // admin ui
  for (const adminButton of document.querySelectorAll<HTMLButtonElement>('.ask-admin .url-actions button')) {
    if (adminButton.closest('.ask-container')) continue;
    adminButton.onclick = async () => {
      await xhrTextRaw(adminButton.formAction, { method: 'POST' });
      site.reload();
    };
  }
}

const enableDragDropTouch = isTouchDevice()
  ? import(site.asset.url('npm/drag-drop-touch.esm.min.js')).then(m => m.enableDragDropTouch)
  : Promise.resolve(() => {});

class Ask {
  anon: boolean;
  submitEl?: Element;
  formEl?: HTMLInputElement;
  viewOrder: string; // the initial order of picks when 'random' tag is used
  initialRanks: string; // initial rank order
  initialFormValue: string; // initial form value
  hasPick: boolean; // whether there are picks/form data for this (ask, user) in the db

  constructor(readonly el: HTMLElement) {
    this.anon = this.el.classList.contains('anon');
    this.hasPick = this.el.dataset.hasPick === 'true';
    this.viewOrder = Array.from($('.choice', this.el), e => e?.getAttribute('value')).join('-');
    this.initialRanks = this.ranking();
    wireSubmit(this);
    wireForm(this);
    wireRankedChoices(this);
    wireExclusiveChoices(this);
    wireMultipleChoices(this);
    wireActions(this);
  }

  ranking(): string {
    return Array.from(this.el.querySelectorAll('.choice.rank'), el => el?.getAttribute('value')).join('-');
  }

  relabel() {
    const submitted = this.ranking() === this.initialRanks && this.hasPick;
    this.el.querySelectorAll('.choice.rank').forEach((choice, i) => {
      const label = choice.querySelector('div');
      if (label) label.textContent = `${i + 1}`;
      choice.classList.toggle('submitted', submitted);
    });
  }

  setSubmitState(state: 'clean' | 'dirty' | 'success') {
    this.submitEl?.classList.remove('dirty', 'success');
    if (state !== 'clean') this.submitEl?.classList.add(state);
  }

  picksUrl(picks: string): string {
    return `/ask/picks/${this.el.id}${picks ? `?picks=${picks}&` : '?'}view=${this.viewOrder}${
      this.el.classList.contains('anon') ? '&anon=true' : ''
    }`;
  }
}

function wireSubmit(ask: Ask) {
  ask.submitEl = ask.el.querySelector('.form-submit') ?? undefined;
  if (!ask.submitEl) return;

  ask.submitEl.querySelector('input')!.onclick = () => {
    if (!ask.formEl) return;
    postAsk({
      ask,
      url: `/ask/form/${ask.el.id}?view=${ask.viewOrder}&anon=${ask.el.classList.contains('anon')}`,
      body: xhrForm({ text: ask.formEl.value }),
    }).then(updated => updated.setSubmitState('success'));
  };
}

function wireExclusiveChoices(ask: Ask) {
  for (const choice of ask.el.querySelectorAll<HTMLElement>('.choice.exclusive')) {
    choice.onclick = e => {
      const el = e.target as Element;
      postAsk({ ask, url: ask.picksUrl(el.classList.contains('selected') ? '' : el.getAttribute('value')!) });
      e.preventDefault();
    };
  }
}

function wireMultipleChoices(ask: Ask) {
  for (const choice of ask.el.querySelectorAll<HTMLElement>('.choice.multiple')) {
    choice.onclick = e => {
      if (!(e.target instanceof HTMLElement)) return;
      e.target.classList.toggle('selected');
      const picks = Array.from(ask.el.querySelectorAll<HTMLElement>('.choice'))
        .filter(x => x.classList.contains('selected'))
        .map(x => x.getAttribute('value'));
      postAsk({ ask, url: ask.picksUrl(picks.join('-')) });
      e.preventDefault();
    };
  }
}

function wireForm(ask: Ask) {
  ask.formEl = ask.el.querySelector<HTMLInputElement>('.form-text')!;
  if (!ask.formEl) return;
  ask.initialFormValue = ask.formEl.defaultValue;
  ask.formEl.oninput = () => {
    const dirty =
      ask.formEl?.value !== ask.initialFormValue ||
      (ask.initialRanks && (ask.ranking() !== ask.initialRanks || !ask.hasPick));
    ask.setSubmitState(dirty ? 'dirty' : 'clean');
  };
  ask.formEl.onkeydown = (e: KeyboardEvent) => {
    if (
      e.key !== 'Enter' ||
      e.shiftKey ||
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      !ask.submitEl?.classList.contains('dirty')
    )
      return;
    ask.submitEl.querySelector('input')!.click();
    e.preventDefault();
  };
}

function wireActions(ask: Ask) {
  for (const button of ask.el.querySelectorAll<HTMLButtonElement>('.url-actions button')) {
    button.onclick = () => postAsk({ ask, method: button.formMethod, url: button.formAction });
  }
}

async function wireRankedChoices(ask: Ask) {
  const container = ask.el.querySelector<HTMLElement>('.ask__choices');
  if (!container) return;

  (await enableDragDropTouch)(ask.el, ask.el, { forceListen: false }); // polyfill phones

  let ctx: DragContext;

  const vertical = container.classList.contains('vertical');
  const cursorEl = vertical ? frag<Element>('<hr>') : frag<Element>('<div class="cursor">');
  const breakEl = vertical ? null : frag<Element>('<div style="flex-basis: 100%">');
  const updateCursor = throttle(100, (d: DragContext, e: DragEvent) => {
    if (!d || d.isDone) return;

    if (vertical) updateVCursor(d, e);
    else updateHCursor(d, e);
  });

  ask.el.ondragover = ask.el.ondragleave = e => {
    e.preventDefault();
    updateCursor(ctx, e);
  };

  for (const choice of ask.el.querySelectorAll<HTMLElement>('.choice.rank')) {
    let timeout: Timeout;
    choice.ondragstart = e => {
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', '');
      const dragEl = e.target as Element;
      ctx = {
        dragEl,
        parentEl: dragEl.parentElement!,
        box: dragEl.parentElement!.getBoundingClientRect(),
        cursorEl,
        breakEl,
        choices: Array.from($('.choice.rank', ask.el), e => e!),
        isDone: false,
        lastTarget: null,
      };
      timeout = setTimeout(() => dragEl.classList.add('dragging'), 100);
    };
    choice.ondragend = e => {
      e.preventDefault();
      ctx.isDone = true;
      clearTimeout(timeout);
      ctx.dragEl.classList.remove('dragging');
      if (ctx.cursorEl.parentElement !== ctx.parentEl) return;
      ctx.parentEl.insertBefore(ctx.dragEl, ctx.cursorEl);
      ctx.cursorEl.remove();
      ctx.breakEl?.remove();
      ask.relabel();
      if (ask.ranking() !== ask.initialRanks || !ask.hasPick)
        postAsk({ ask, url: ask.picksUrl(ask.ranking()) });
    };
  }
}

async function postAsk(req: { ask: Ask; url: string; method?: string; body?: FormData }): Promise<Ask> {
  const rsp = await xhrTextRaw(req.url, { method: req.method || 'POST', body: req.body });
  if (rsp.redirected) {
    if (!rsp.url.startsWith(window.location.origin)) throw new Error(`Bad redirect: ${rsp.url}`);
    window.location.href = rsp.url;
    return req.ask;
  }
  const container = req.ask.el.closest('.ask-container');
  if (!container) return req.ask;

  container.innerHTML = await ensureOk(rsp).then(rsp => rsp.text());
  return new Ask(container.firstElementChild as HTMLElement);
}

type DragContext = {
  dragEl: Element;
  parentEl: Element; // container of the draggables
  box: DOMRect; // parentEl's content box - containing all draggables
  cursorEl: Element; // the insertion cursor (<hr> if vertical, otherwise an I-beam)
  breakEl: Element | null; // null if vertical, otherwise an empty div that consumes the remainder of a row
  choices: Array<Element>; // the draggable elements
  isDone: boolean; // ignore dragover events delayed past the drop by the throttle
  lastTarget: { el: Element; break: 'beforebegin' | 'afterend' | null } | null; // track dirty state
};

function updateVCursor(ctx: DragContext, { clientX: x, clientY: y }: DragEvent) {
  if (x <= ctx.box.left || x >= ctx.box.right || y <= ctx.box.top || y >= ctx.box.bottom) {
    ctx.cursorEl.remove();
    ctx.breakEl?.remove();
    return;
  }
  let target: Element | null = null;
  for (let i = 0; i < ctx.choices.length && !target; i++) {
    const r = ctx.choices[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) target = ctx.choices[i];
  }
  ctx.parentEl.insertBefore(ctx.cursorEl, target);
}

function updateHCursor(ctx: DragContext, { clientX: x, clientY: y }: DragEvent) {
  const occlusionOffsetY = isTouchDevice() ? 32 : 4; // 4px is half the row gap, 28px is fingertip occlusion
  if (x <= ctx.box.left || x >= ctx.box.right || y <= ctx.box.top || y >= ctx.box.bottom + occlusionOffsetY) {
    ctx.cursorEl.remove();
    ctx.breakEl?.remove();
    ctx.lastTarget = null;
    return;
  }
  const rtl = document.dir === 'rtl';
  let target: DragContext['lastTarget'] = null;
  for (let i = 0, lastY = 0; i < ctx.choices.length && !target; i++) {
    const r = ctx.choices[i].getBoundingClientRect();
    const choiceMidX = r.right - r.width / 2;
    const belowChoiceY = r.bottom + occlusionOffsetY;
    const rowBreak = i > 0 && belowChoiceY !== lastY;
    if (rowBreak && y <= lastY) target = { el: ctx.choices[i], break: 'afterend' };
    else if (y <= belowChoiceY && (rtl ? x >= choiceMidX : x <= choiceMidX))
      target = { el: ctx.choices[i], break: rowBreak ? 'beforebegin' : null };
    lastY = belowChoiceY;
  }
  if (ctx.lastTarget && target && ctx.lastTarget.el === target.el && ctx.lastTarget.break === target.break)
    return;

  ctx.lastTarget = target; // keep last target in context data so we only mutate the DOM when dirty

  if (!target) {
    ctx.parentEl.insertBefore(ctx.cursorEl, null);
    return;
  }
  ctx.parentEl.insertBefore(ctx.cursorEl, target.el);
  if (target.break) {
    // don't add break when inserting the cursor at the end of a line with no room
    if (target.break !== 'afterend' || ctx.cursorEl.getBoundingClientRect().top < y)
      ctx.cursorEl.insertAdjacentElement(target.break, ctx.breakEl!);
  } else ctx.breakEl?.remove();
}
