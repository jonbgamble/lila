import * as co from 'chessops';

import { clamp } from '@/algo';
import { normalMove } from '@/game';

import type { FilterResult, FilterSpec } from '../filter';
import type { SearchMove, MoveArgs } from '../types';

export const pawnStructure: FilterSpec = {
  score,
  info: {
    label: 'pawn structure',
    type: 'filter',
    class: ['filter'],
    value: { range: { min: 0, max: 1 }, by: 'avg' },
    requires: {
      some: [
        'behavior_fish_multipv > 1',
        'behavior_zero_multipv > 1',
        { every: ['behavior_zero', 'behavior_fish'] },
      ],
    },
    title: $trim`
    pawn structure assigns weights up to the graph value for pawns that support each other, control the center,
    and are not doubled or isolated.
    
    This filter assigns a weight between 0 and the limiter.`,
  },
};

function score(moves: SearchMove[], args: MoveArgs, limiter: number): Promise<FilterResult> {
  const rawScores: Record<Uci, number> = {};
  for (const { uci } of moves) {
    const chess = args.chess.clone();
    chess.play(normalMove(chess, uci)!.move);
    rawScores[uci] = positionScore(chess, args.chess.turn);
  }
  const distinct = Array.from(new Set<number>(Object.values<number>(rawScores))).sort((a, b) => a - b);
  const stepped = new Map<number, number>(distinct.map((raw, i) => [raw, (i + 1) / distinct.length]));
  const result: FilterResult = {};
  for (const { uci } of moves) {
    result[uci] = Math.round(stepped.get(rawScores[uci])! * limiter * 100) / 100;
  }
  return Promise.resolve(result);
}

// michael's python algorithm: https://hq.lichess.ovh/#narrow/channel/8-dev/topic/Fancy.20Bots/near/3803327

function positionScore(b: co.Position, color: Color): number {
  const pawnSquares: co.SquareSet = b.board.pieces(color, 'pawn');
  const pawnsOnFile = Array<number>(8).fill(0);
  const pos: [number, number][] = [];
  let score = 0;

  // Advancement score
  for (const sq of pawnSquares) {
    const [file, rank] = [co.squareFile(sq), co.squareRank(sq)];
    pawnsOnFile[file]++;
    pos.push([file, rank]);
    score += (color === 'white' ? rank : 7 - rank) / 7.0;
  }
  // Penalize doubled pawns
  for (const pawns of pawnsOnFile) if (pawns > 1) score -= 0.75 * (pawns - 1);

  // Reward tightly connected pawns (within 1 square including diagonally)
  for (let i = 0; i < pos.length; i++) {
    const [iFile, iRank] = pos[i];
    for (let j = i + 1; j < pos.length; j++) {
      const [jFile, jRank] = pos[j];

      if (Math.abs(iFile - jFile) === 1 && Math.abs(iRank - jRank) < 2) {
        // same rank 0.5, supporting diagonal 0.75. because we want to march them
        score += iRank === jRank ? 0.5 : 0.75;
      }
    }
  }
  return clamp((score + 2) / 12.5, { min: 0, max: 1 });
}
