import { isEquivalent } from '@/algo';
import { memoize } from '@/index';
import { pubsub } from '@/pubsub';

import type { FilterSpec, FilterInfo } from './filter';
import { aggression } from './filters/aggression';
import { fuzz } from './filters/fuzz';
import { pawnStructure } from './filters/pawnStructure';
import { makeSandboxFilter } from './filters/sandbox/sandboxFilter';

export const filterRegistry: () => FilterRegistry = memoize(() => new FilterRegistry());

class FilterRegistry {
  private readonly registry: Map<string, FilterSpec> = new Map();
  private running = false;

  register(key: string, spec: FilterSpec): void {
    const oldInfo = this.registry.get(key)?.info;
    this.registry.set(key, spec);
    if (this.running && !isEquivalent(oldInfo, spec.info)) this.notify();
  }

  notify(): void {
    pubsub.emit(
      'botdev.update.filters',
      Object.fromEntries([...this.registry.entries()].map(([k, spec]) => [k, spec.info])),
    );
    this.running = true;
  }
  getFilter(key: string): FilterSpec | undefined {
    return this.registry.get(key);
  }
}

const example = `
  function score(moves, args, limiter) {
    const result = {};
    for (const { uci } of moves) {
      result[uci] = Math.random();
    }
    console.log(co.Chess);
    return result;
  }`;

const exampleInfo: FilterInfo = {
  type: 'filter',
  class: ['filter'],
  value: { range: { min: -1, max: 1 }, by: 'avg' },
  label: 'third party demo',
  title: $trim`
        this is a third party yada yada`,
};

filterRegistry().register('aggression', aggression);
filterRegistry().register('pawnStructure', pawnStructure);
filterRegistry().register('fuzz', fuzz);
filterRegistry().register('example', makeSandboxFilter(example, exampleInfo));
