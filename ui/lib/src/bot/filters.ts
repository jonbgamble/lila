import './filters/aggression';
import './filters/pawnStructure';
import { Bot } from './bot';

import { makeFilterWorker } from './filters/external/filterWorker';

const example = `
function score(moves, args, limiter) {
  const result = {};
  for (const { uci } of moves) {
    result[uci] = Math.random();
  }
  return result;
}
`;
makeFilterWorker(example).then(filterSpec => Bot.registerFilter('example', filterSpec));
