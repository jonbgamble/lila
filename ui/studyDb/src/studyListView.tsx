import { licon } from 'lib/licon';
import { pubsub } from 'lib/pubsub';
import { jsx, spinnerVdom, type Hooks, type VNode, type VNodeData } from 'lib/view';
import { url } from 'lib/xhr';

import type { HistoryTabContent } from './historyTabContent';
import type { MemberTabContent } from './memberTabContent';
import { popupData } from './popupData';
import type { ResultTabContent } from './resultTabContent';
import type { Bookmark, StudyData, StudyPosition } from './types';

export function studyListView(list: MemberTabContent | ResultTabContent, controls?: VNode): VNode {
  const results = list.results;
  const isResult = list.kind === 'resultTab';
  const body = (
    <div class="body" key={list.revision}>
      {results.length > 0 && (
        <ul class="studies" attrs={{ role: 'listbox', 'aria-multiselectable': 'true' }}>
          {results.map(study => studyRow(list, study))}
        </ul>
      )}
      {list.error && (
        <div class="error" attrs={{ role: 'alert' }}>
          {list.error}
          <button attrs={{ type: 'button' }} on={{ click: () => list.retry() }}>
            Retry
          </button>
        </div>
      )}
      {list.loading && isResult && (
        <div class="status" attrs={{ role: 'status' }}>
          {spinnerVdom()}
        </div>
      )}
      {!list.loading && !list.error && !results.length && (list.exhausted || !list.hasMore) && (
        <div class="status">{i18n.site.none}</div>
      )}
      {list.hasMore && (!list.loading || list.exhausted) && (!list.error || list.exhausted) && (
        <div
          class="scroll-boundary"
          attrs={{ 'aria-hidden': 'true' }}
          hook={infiniteScroll(() => list.loadMore())}
        />
      )}
    </div>
  );
  return (
    <div class="study-list" {...listData(list.id)}>
      {studyFilterInput(list)}
      {isResult && <div class="submitted-query">{list.submitted}</div>}
      {controls}
      {body}
    </div>
  );
}

export function studyRow(
  list: HistoryTabContent | MemberTabContent | ResultTabContent,
  study: StudyData,
): VNode {
  const position = list.kind === 'historyTab' ? study.visit : undefined;
  const chapterName = study.chapters?.find(chapter => chapter.id === position?.chapterId)?.name;
  const selected = list.selected.has(study.studyId);
  const entry = 'visibility' in study ? study : undefined;
  return (
    <li
      class={['study-row', selected && 'selected']}
      key={study.studyId}
      attrs={{ role: 'option', tabindex: 0, 'aria-selected': String(selected), draggable: 'true' }}
      on={{
        click: (event: MouseEvent) => {
          if (!(event.target as HTMLElement).closest('a, button')) list.select(study.studyId, event);
        },
        keydown: (event: KeyboardEvent) => {
          if ((event.target as HTMLElement).closest('a, button')) return;
          if (event.key === ' ') {
            event.preventDefault();
            list.select(study.studyId, event);
          } else if (event.key === 'Enter') studyLink(study, position).navigate();
        },
        dragstart: (event: DragEvent) => list.drag(study.studyId, event),
      }}>
      {studyIcon(study.flair)}
      <div class="study-content">
        {position ? (
          <strong class="study-name">{study.studyName}</strong>
        ) : (
          <span class="study-name">{study.studyName}</span>
        )}
        {chapterName && <span class="study-chapter">{chapterName}</span>}
        {entry ? studyPermission(entry) : <span class="study-permission" />}
      </div>
      {studyNavigator(
        study,
        position,
        list.kind === 'resultTab' ? list.matchingChapterFields.get(study.studyId) : undefined,
      )}
      {studyMatchView(study, list.query)}
    </li>
  );
}

export function studyPermission(entry: StudyData): VNode {
  const sorted = entry.members?.slice().sort((a, b) => {
    if (a.user.id === entry.ownerId) return -1;
    if (b.user.id === entry.ownerId) return 1;
    if (a.role === 'w' && b.role !== 'w') return -1;
    if (b.role === 'w' && a.role !== 'w') return 1;
    return a.user.name.localeCompare(b.user.name);
  });
  const members =
    sorted?.map(({ user, role }) => {
      const permission = user.id === entry.ownerId ? 'Owner' : role === 'w' ? 'Contributor' : 'Member';
      return { name: `${user.title ? user.title + ' ' : ''}${user.name} - ${permission}` };
    }) ?? (entry.owner ? [{ name: entry.owner.name + ' - Owner' }] : []);
  const preview = popupData(entry.role ? members : []);
  const [icon, label] =
    entry.role === 'owner'
      ? [licon.Owner, 'Owner']
      : entry.role === 'contributor'
        ? [licon.WritePermission, 'Contributor']
        : entry.role === 'member'
          ? [licon.User, 'Member']
          : entry.visibility === 'public'
            ? [licon.Meridians, 'Public study']
            : [undefined, ''];
  return (
    <span
      class={['study-permission', entry.role && 'role-' + entry.role]}
      {...preview}
      attrs={{
        ...preview.attrs,
        role: 'img',
        title: !entry.role && entry.visibility === 'public' && label,
        'aria-label': label,
        'data-icon': icon,
      }}></span>
  );
}

export function studyNavigator(
  study: StudyData | Bookmark,
  position?: StudyPosition,
  matchingFields?: StudyData['matchingChapterFields'],
): VNode {
  const entry = 'visibility' in study ? study : undefined;
  const link = studyLink(study, position);
  const chapterName = entry?.chapters?.find(chapter => chapter.id === position?.chapterId)?.name;
  const chapters =
    entry?.chapters?.map(chapter => {
      const fields = matchingFields?.[chapter.id];
      return {
        name: fields?.length ? `${chapter.name} - ${fields.join(', ')}` : chapter.name,
        ...studyLink(study, { chapterId: chapter.id }),
      };
    }) ?? [];
  const count = entry?.chapterCount;
  const preview = popupData(chapters);
  return (
    <span class="study-navigation">
      <button class="button-empty study-chapter-count" {...preview}>
        {count}
      </button>
      <a
        class="study-navigate"
        attrs={{
          href: link.href,
          'aria-label': `Navigate to ${study.studyName}${chapterName ? ' - ' + chapterName : ''}`,
          'data-icon': licon.InternalArrow,
        }}
        on={{
          click: (event: MouseEvent) => {
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            link.navigate();
          },
        }}></a>
    </span>
  );
}

export function studyFilterInput(content: { query: string; filterChanged(): void }): VNode {
  return (
    <input
      class="study-filter"
      attrs={{ type: 'search', placeholder: 'Filter', 'aria-label': 'Filter', maxlength: 100 }}
      props={{ value: content.query }}
      on={{
        input: (event: Event) => {
          content.query = (event.target as HTMLInputElement).value;
          content.filterChanged();
        },
      }}
    />
  );
}

export function studyMatchView(entry: StudyData, filter: string): VNode | undefined {
  const query = filter.trim().toLowerCase();
  if (!query || entry.studyName?.toLowerCase().includes(query)) return undefined;
  const matches = (text?: string) => !!text?.toLowerCase().includes(query);
  const lines: VNode[] = [];
  if (matches(entry.description))
    lines.push(
      <div class="study-match" key="description">
        {highlightMatch(matchSnippet(entry.description!, query), query)}
      </div>,
    );
  if (entry.topics?.some(matches))
    lines.push(
      <div class="study-match" key="topics">
        {highlightMatch(entry.topics.join(', '), query)}
      </div>,
    );
  for (const chapter of entry.chapters ?? []) {
    if (matches(chapter.name)) {
      lines.push(
        <div class="study-match" key={chapter.id}>
          {highlightMatch(chapter.name, query)}
        </div>,
      );
      continue;
    }
    const tags = chapter.tags?.filter(([, value]) => matches(value)) ?? [];
    const description = matches(chapter.description) ? chapter.description : undefined;
    if (!tags.length && description === undefined) continue;
    lines.push(
      <div class="study-match" key={chapter.id}>
        <span class="study-match-chapter">{chapter.name}: </span>
        {tags.map(([name, value], index) => (
          <span>
            {index > 0 ? '; ' : ''}
            {name}: {highlightMatch(matchSnippet(value, query), query)}
          </span>
        ))}
        {description !== undefined && (
          <span>
            {tags.length ? '; ' : ''}
            {highlightMatch(matchSnippet(description, query), query)}
          </span>
        )}
      </div>,
    );
  }
  return lines.length ? <div class="study-matches">{lines}</div> : undefined;
}

function matchSnippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query);
  if (index === -1) return text;
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 40);
  return `${start ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function highlightMatch(text: string, query: string): (string | VNode)[] {
  const parts: (string | VNode)[] = [];
  const lower = text.toLowerCase();
  let offset = 0;
  let index = lower.indexOf(query);
  while (index >= 0) {
    parts.push(text.slice(offset, index), <mark>{text.slice(index, index + query.length)}</mark>);
    offset = index + query.length;
    index = lower.indexOf(query, offset);
  }
  parts.push(text.slice(offset));
  return parts;
}

export function studyLink(study: Pick<StudyData, 'studyId'>, position?: StudyPosition) {
  return {
    href: url(['/study', study.studyId, position?.chapterId].filter(Boolean).join('/'), {
      path: position?.path,
      orientation: position?.orientation,
    }),
    navigate: () => pubsub.emit('study.navigate', { studyId: study.studyId, ...position }),
  };
}

export function studyIcon(flair?: string): VNode {
  return flair ? (
    <img class="study-icon" attrs={{ src: site.asset.flairSrc(flair), alt: '', draggable: 'false' }} />
  ) : (
    <span class="study-icon" attrs={{ 'data-icon': licon.StudyBoard, 'aria-hidden': 'true' }} />
  );
}

export function listData(tab: string): VNodeData {
  return {
    key: tab,
    attrs: {
      role: 'tabpanel',
      'aria-labelledby': tab,
    },
  };
}

export function infiniteScroll(loadMore: () => Promise<void>): Hooks {
  let observer: IntersectionObserver | undefined;
  const observe = (vnode: VNode) => {
    if (!window.IntersectionObserver) return;
    const boundary = vnode.elm as HTMLElement;
    observer = new window.IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer!.disconnect();
          loadMore();
        }
      },
      { root: boundary.parentElement, rootMargin: '0px 0px 100px 0px' },
    );
    observer.observe(boundary);
  };
  return {
    insert: observe,
    postpatch: (previous, vnode) => {
      previous.data?.hook?.destroy?.(previous);
      observe(vnode);
    },
    destroy: () => observer?.disconnect(),
  };
}
