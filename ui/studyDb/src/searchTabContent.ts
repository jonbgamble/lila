import { licon } from 'lib/licon';

import { TabContentCtrl } from './tabContentCtrl';
import type { StudySearchOrder, StudySearchQuery } from './types';

export class SearchTabContent extends TabContentCtrl {
  readonly kind = 'searchTab';
  readonly label = 'Search';
  readonly icon = licon.Search;
  query = '';
  order: StudySearchOrder = 'relevant';
  study: NonNullable<StudySearchQuery['study']> = {};
  chapter: Omit<NonNullable<StudySearchQuery['chapter']>, 'tags'> = {};
  tags: NonNullable<NonNullable<StudySearchQuery['chapter']>['tags']> = {};

  get search(): StudySearchQuery {
    const clean = <Fields extends object>(fields: Fields): Fields | undefined => {
      const entries = Object.entries(fields)
        .map(([key, value]) => [key, (value as string).trim()])
        .filter(([, value]) => value);
      return entries.length ? (Object.fromEntries(entries) as Fields) : undefined;
    };
    const study = clean({ ...this.study, text: this.query });
    const chapter = clean(this.chapter);
    let tags = clean(this.tags);
    if (tags) {
      if (!tags.player1 && !tags.fideId1) delete tags.color1;
      if (!tags.player2 && !tags.fideId2) delete tags.color2;
      if (!Object.keys(tags).length) tags = undefined;
    }
    return {
      order: this.order,
      ...(study && { study }),
      ...((chapter || tags) && { chapter: { ...chapter, ...(tags && { tags }) } }),
    };
  }

  get canSubmit(): boolean {
    const { study, chapter } = this.search;
    return !!(study || chapter);
  }
}
