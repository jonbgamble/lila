function score(moves, args, limiter) {
  const result = {};
  for (const { uci } of moves) {
    result[uci] = Math.random();
  }
  return result;
}
