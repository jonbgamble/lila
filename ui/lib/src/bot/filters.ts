import { aggression } from './filters/aggression';
import { pawnStructure } from './filters/pawnStructure';
import type { FilterSpec, FilterInfo } from './filter';
import { pubsub } from '@/pubsub';
import { memoize } from '@/index';
import { isEquivalent } from '@/algo';
import { makeFilterWorker } from './filters/external/filterWorker';

export const filterRegistry: () => FilterRegistry = memoize(() => new FilterRegistry());

class FilterRegistry {
  private registry: Map<string, FilterSpec> = new Map();
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
    console.log(this.registry);
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
filterRegistry().register('example', makeFilterWorker(example, exampleInfo));
