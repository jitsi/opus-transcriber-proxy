export interface TimeSpan {
  start: number;
  end: number;
}

/**
 * Attribute each word to a speaker turn by MAX temporal overlap. For a word
 * that overlaps no turn, the overlap value is negative and its maximum is the
 * smallest gap, so this also yields the nearest turn. Returns, for each word,
 * the index of its turn (-1 only when turns is empty).
 */
export function alignWordsToTurns(words: TimeSpan[], turns: TimeSpan[]): number[] {
  return words.map((w) => {
    let bestIdx = -1;
    let bestOverlap = -Infinity;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const overlap = Math.min(w.end, t.end) - Math.max(w.start, t.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    return bestIdx;
  });
}
