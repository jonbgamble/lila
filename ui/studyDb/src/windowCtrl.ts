import { focusableWithin } from 'lib/view/focus';

import type { StudyDbCtrl } from './studyDbCtrl';
import { syncCtrl } from './syncCtrl';
import type { TabContent } from './tabContentCtrl';
import type { StoredTab } from './types';
import { WindowFrame } from './windowFrame';
import type { Rect } from './windowGeometry';

export class WindowCtrl {
  selectedTabId: string;
  readonly redraw = () => this.frame?.redraw();
  frame?: WindowFrame;
  private readonly unwatch = syncCtrl.watch(this.redraw);

  constructor(
    readonly owner: StudyDbCtrl,
    readonly tabCtrls: readonly TabContent[],
    public geometry: Rect,
  ) {
    this.selectedTabId = tabCtrls[0].id;
  }

  show(): void {
    if (this.frame || !this.owner.hasWindow(this)) return;
    this.frame = new WindowFrame(this);
    this.frame.show();
  }

  dispose(): void {
    this.unwatch();
    const frame = this.frame;
    this.frame = undefined;
    frame?.close();
  }

  freeze(): StoredTab[] {
    return this.tabCtrls.map(contentCtrl => ({
      ...(contentCtrl.kind === 'resultTab'
        ? { kind: contentCtrl.kind, search: contentCtrl.search }
        : { kind: contentCtrl.kind }),
      active: contentCtrl.id === this.selectedTabId,
      geometry: { ...this.geometry },
    }));
  }

  setGeometry(rect: Rect): void {
    this.geometry = rect;
    this.owner.save();
  }

  get activeContentCtrl(): TabContent {
    const content = this.tabCtrls.find(content => content.id === this.selectedTabId);
    if (!content) throw new Error('no selected content');
    return content;
  }

  focusContent(): void {
    const panel = this.frame?.frame?.dialog.querySelector<HTMLElement>('.content-frame');
    if (panel) focusableWithin(panel)[0]?.focus({ preventScroll: true });
  }

  selectTab(id: string): void {
    if (!this.tabCtrls.some(content => content.id === id)) throw new Error(`window has no ${id} content`);
    this.selectedTabId = id;
    this.redraw();
    this.owner.save();
  }
}
