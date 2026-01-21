/**
 * Determines side to move from FEN.
 * FEN format: ".... w ...." or ".... b ...."
 */
export function getTurnFromFen(fen) {
  const parts = fen.trim().split(/\s+/);
  return parts[1] === "b" ? "b" : "w";
}

/**
 * Normalize evaluation to "white perspective":
 * + means White is better, - means Black is better.
 *
 * If Stockfish is scoring from side-to-move (common behavior),
 * then when it's black to move, we invert the score.
 *
 * This works for both cp and mate.
 */
export function normalizeEvalToWhitePerspective({ evalType, evalValue, turn }) {
  if (evalValue === null || typeof evalValue !== "number") {
    return evalValue;
  }

  // If it's black to move, flip sign so it's always white perspective
  if (turn === "b") {
    return -evalValue;
  }

  return evalValue;
}
