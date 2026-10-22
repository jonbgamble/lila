import { json, jsonHeader, xhrHeader } from 'lib/xhr';

import { StudyList } from './studyList';
import type { StudyData, StudySearchQuery } from './types';

export class ResultTabContent extends StudyList {
  readonly kind = 'resultTab';
  readonly icon = undefined;
  override readonly closable = true;

  readonly search: StudySearchQuery;
  readonly matchingChapterFields = new Map<string, StudyData['matchingChapterFields']>();
  exhausted = false;
  error?: string;
  private cursor?: number;
  private request?: object;
  private readonly filterTerms: string[];
  private autoFilter = true;

  constructor(search: StudySearchQuery) {
    super();
    this.search = structuredClone(search);
    const tags = search.chapter?.tags;
    this.filterTerms = [
      tags?.fideId1,
      tags?.fideId2,
      tags?.player1,
      tags?.player2,
      tags?.event,
      tags?.opening,
      tags?.eco,
      search.study?.text,
      tags?.variant,
    ].filter((term): term is string => Boolean(term));
  }

  get submitted(): string {
    return [
      ...Object.values(this.search.study ?? {}),
      this.search.chapter?.text,
      this.search.chapter?.name,
      this.search.chapter?.description,
      ...Object.values(this.search.chapter?.tags ?? {}),
    ]
      .filter(Boolean)
      .join(' | ');
  }

  get label(): string {
    return this.search.study?.text ?? this.submitted;
  }

  protected override compare(): number {
    return 0;
  }

  get loading(): boolean {
    return !!this.request;
  }

  override get hasMore(): boolean {
    return super.hasMore || !this.exhausted;
  }

  override filterChanged(): void {
    this.autoFilter = false;
    super.filterChanged();
  }

  protected override async load(): Promise<void> {
    this.request = undefined;
    this.exhausted = false;
    this.cursor = undefined;
    this.visible = 50;
    this.revision++;
    this.matchingChapterFields.clear();
    await this.fill();
  }

  override async loadMore(): Promise<void> {
    if (this.loading || this.error || !this.hasMore) return;
    this.visible += 50;
    if (this.exhausted || this.filtered.length >= this.visible) this.onChange();
    else await this.fill();
  }

  async retry(): Promise<void> {
    this.error = undefined;
    await this.fill();
  }

  private async fill(): Promise<void> {
    const signal = this.signal;
    if (!signal || signal.aborted || this.loading) return;
    const loaded = this.exhausted || this.cursor !== undefined;
    if (loaded && (this.exhausted || this.filtered.length >= this.visible)) return;
    const request = (this.request = {});
    this.error = undefined;
    this.onChange();
    try {
      const batch = await json<{ items: StudyData[]; nextCursor: number | null }>('/study/db/search', {
        method: 'POST',
        headers: { ...jsonHeader, ...xhrHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          query: { scope: { kind: 'search' }, study: this.search.study, chapter: this.search.chapter },
          order: this.search.order,
          cursor: this.cursor,
        }),
        signal,
      });
      if (signal.aborted || request !== this.request) return;
      for (const study of batch.items)
        this.matchingChapterFields.set(study.studyId, study.matchingChapterFields);
      this.entries = [...(loaded ? this.entries : []), ...batch.items];
      if (!loaded && this.autoFilter)
        this.query = batch.items.length
          ? (this.filterTerms.find(term =>
              batch.items.every(entry => this.matches(entry, term.trim().toLowerCase())),
            ) ?? '')
          : '';
      this.cursor = batch.nextCursor ?? undefined;
      this.exhausted = batch.nextCursor == null;
    } catch {
      if (!signal.aborted && request === this.request) this.error = 'Unable to load studies';
    } finally {
      if (request === this.request) {
        this.request = undefined;
        if (!signal.aborted) this.onChange();
      }
    }
  }
}
