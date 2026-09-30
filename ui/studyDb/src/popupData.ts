import type { VNodeData } from 'lib/view';

interface PopupItem {
  name: string;
  href?: string;
  navigate?: () => void;
}

const previews = new WeakMap<HTMLElement, PopupItem[]>();

export function popupData(items: PopupItem[]): VNodeData {
  if (!items.length) return {};
  return {
    attrs: { tabindex: 0, 'aria-describedby': 'studyContentPreview' },
    hook: {
      insert: vnode => {
        const element = vnode.elm as HTMLElement;
        previews.set(element, items);
        $(element).powerTip({
          popupId: 'studyContentPreview',
          placement: 's',
          offset: 4,
          render: async trigger => {
            const popup = document.querySelector<HTMLElement>('#studyContentPreview')!;
            popup.setAttribute('role', 'tooltip');
            popup.style.maxHeight = `${Math.max(80, window.innerHeight - trigger.getBoundingClientRect().bottom - 12)}px`;
            const list = document.createElement('ul');
            for (const entry of previews.get(trigger) ?? []) {
              const item = document.createElement('li');
              if (entry.href) {
                const link = document.createElement('a');
                link.href = entry.href;
                link.textContent = entry.name;
                link.addEventListener('click', event => {
                  if (
                    event.button ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    event.altKey ||
                    !entry.navigate
                  )
                    return;
                  event.preventDefault();
                  $.powerTip.hide(trigger, true);
                  entry.navigate();
                });
                item.append(link);
              } else item.textContent = entry.name;
              list.append(item);
            }
            popup.replaceChildren(list);
          },
        });
      },
      postpatch: (_previous, vnode) => previews.set(vnode.elm as HTMLElement, items),
      destroy: vnode => {
        const element = vnode.elm as HTMLElement;
        $.powerTip.destroy(element);
        previews.delete(element);
      },
    },
    on: {
      focusin: event => $.powerTip.show(event.currentTarget),
      focusout: event => $.powerTip.hide(event.currentTarget),
      keydown: event => {
        const key = event.key;
        if ((event.currentTarget as HTMLElement).tagName === 'A' && key !== 'Escape') return;
        if (!['Enter', ' ', 'Escape'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'Escape') $.powerTip.hide(event.currentTarget, true);
        else $.powerTip.show(event.currentTarget);
      },
    },
  };
}
