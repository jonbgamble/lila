import * as co from 'chessops';
import type { SearchMove } from '../types';
import type { FilterResult, FilterSpec } from '../filter';

export const fuzz: FilterSpec = {
  info: {
    label: 'fuzz',
    type: 'filter',
    class: ['filter'],
    value: { range: { min: -1, max: 1 }, by: 'avg' },
    requires: {
      some: [
        'behavior_fish_multipv > 1',
        'behavior_zero_multipv > 1',
        { every: ['behavior_zero', 'behavior_fish'] },
      ],
    },
    title: $trim`
      yet another randomization filter.
      
      fuzz assigns a random weight between 0 and the limiter to each move.
      
      this is more tuneable and less chaotic than move decay.`,
  },
  async score(moves: SearchMove[]): Promise<FilterResult> {
    const result: { [uci: Uci]: number } = {};
    for (const { uci } of moves) {
      result[uci] = Math.random();
    }
    console.log(co.Chess);
    return result;
  },
};
