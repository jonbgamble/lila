import { licon } from 'lib/licon';
import { jsx, spinnerVdom, type VNode } from 'lib/view';

import type { MemberTabContent } from './memberTabContent';
import { studyListView } from './studyListView';

const roles = ['owner', 'contributor', 'member'] as const;
const labels = { member: 'Member', contributor: 'Contributor', owner: 'Owner' };

export function memberView(content: MemberTabContent): VNode {
  const selectRole = (role: (typeof roles)[number]) => {
    content.filters.role = role;
    content.filterChanged();
  };
  return studyListView(
    content,
    <div class="member-controls">
      <div
        class="btn-rack"
        attrs={{ role: 'radiogroup', 'aria-label': 'Study permission' }}
        on={{
          keydown: (event: KeyboardEvent) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            const index = roles.indexOf(content.filters.role);
            selectRole(
              roles[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? roles.length - 1
                    : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + roles.length) %
                      roles.length
              ],
            );
            (event.currentTarget as HTMLElement)
              .querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
              ?.focus({ preventScroll: true });
          },
        }}>
        {roles.map(role => (
          <button
            key={role}
            class={['btn-rack__btn', 'member-filter', content.filters.role === role && 'active']}
            attrs={{
              type: 'button',
              role: 'radio',
              'aria-checked': String(content.filters.role === role),
              tabindex: content.filters.role === role ? 0 : -1,
            }}
            on={{ click: () => selectRole(role) }}>
            {labels[role]}
          </button>
        ))}
      </div>
      <div class="btn-rack">
        <button
          class={['btn-rack__btn', 'member-filter', content.filters.private && 'active']}
          attrs={{
            type: 'button',
            'aria-pressed': String(content.filters.private),
          }}
          on={{
            click: () => {
              content.filters.private = !content.filters.private;
              content.filterChanged();
            },
          }}>
          Private
        </button>
      </div>
      <span class="member-sync">
        {content.loading ? (
          <span attrs={{ role: 'status', 'aria-label': 'Synchronizing' }}>{spinnerVdom()}</span>
        ) : (
          <button
            class="button-empty s"
            attrs={{
              type: 'button',
              title: 'Synchronize studies',
              'aria-label': 'Synchronize studies',
              'data-icon': licon.Reload,
            }}
            on={{ click: () => content.retry() }}
          />
        )}
      </span>
    </div>,
  );
}
