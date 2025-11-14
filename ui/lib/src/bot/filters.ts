import { aggression } from './filters/aggression';
import { pawnStructure } from './filters/pawnStructure';
import type { FilterName, FilterSpec } from './filter';
import { pubsub } from '@/pubsub';
import { memoize } from '@/index';

import { makeFilterWorker } from './filters/external/filterWorker';

export const filterRegistry: () => FilterRegistry = memoize(() => new FilterRegistry());

class FilterRegistry {
  private registry: Map<FilterName, Promise<FilterSpec>> = new Map();

  register(key: FilterName, spec: FilterSpec | Promise<FilterSpec>): void {
    console.log('key');
    const specPromise = 'then' in spec ? spec : Promise.resolve(spec);
    this.registry.set(key, specPromise);
    // TODO notify here?
    specPromise.then(p => console.log(p.info));
  }

  async notify(): Promise<void> {
    pubsub.emit(
      'botdev.update.filters',
      Object.fromEntries(
        await Promise.all([...this.registry.entries()].map(async ([k, spec]) => [k, (await spec).info])),
      ),
    );
  }
  async getSpec(key: FilterName): Promise<FilterSpec | undefined> {
    return this.registry.get(key);
  }
}

const example = `
function score(moves, args, limiter) {
  const result = {};
  for (const { uci } of moves) {
    result[uci] = Math.random();
  }
  return result;
}`;

filterRegistry().register('aggression', aggression);
filterRegistry().register('pawnStructure', pawnStructure);
filterRegistry().register('example', makeFilterWorker(example));
