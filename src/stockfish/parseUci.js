/**
 * parseUciInfoLine()
 * Parses Stockfish "info ..." lines into a structured object.
 *
 * Example:
 * info depth 20 seldepth 30 multipv 2 score cp -15 nodes 12345 nps 99999 time 123 pv e2e4 e7e5 ...
 */
export function parseUciInfoLine(line) {
  if (!line || typeof line !== "string") return null;

  const trimmed = line.trim();
  if (!trimmed.startsWith("info ")) return null;

  const tokens = trimmed.split(/\s+/);

  // Base result object
  const result = {
    depth: null,
    selDepth: null,
    multiPv: 1,

    evalType: null, // "cp" | "mate"
    eval: null,     // number (cp or mate)

    pv: [],

    timeMs: null,
    nodes: null,
    nps: null,
    hashFull: null,
  };

  /**
   * Utility: parse int safely
   */
  const toInt = (v) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * Utility: parse float safely
   */
  const toFloat = (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  /**
   * Walk through tokens and extract key/value sections.
   * Important: PV is "the rest of the tokens" after "pv"
   */
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];

    // depth
    if (t === "depth") {
      result.depth = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    // seldepth
    if (t === "seldepth") {
      result.selDepth = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    // multipv
    if (t === "multipv") {
      result.multiPv = toInt(tokens[i + 1]) || 1;
      i += 1;
      continue;
    }

    // time (ms)
    if (t === "time") {
      result.timeMs = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    // nodes
    if (t === "nodes") {
      result.nodes = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    // nps
    if (t === "nps") {
      result.nps = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    // hashfull
    if (t === "hashfull") {
      result.hashFull = toInt(tokens[i + 1]);
      i += 1;
      continue;
    }

    /**
     * score cp <int>   OR   score mate <int>
     * Example:
     * score cp 34
     * score mate -3
     */
    if (t === "score") {
      const scoreType = tokens[i + 1]; // cp or mate
      const scoreValue = tokens[i + 2];

      if (scoreType === "cp") {
        result.evalType = "cp";
        result.eval = toInt(scoreValue);
      } else if (scoreType === "mate") {
        result.evalType = "mate";
        result.eval = toInt(scoreValue);
      }

      // skip 2 tokens we consumed: <type> <value>
      i += 2;
      continue;
    }

    /**
     * PV moves: everything after "pv" until end of line
     */
    if (t === "pv") {
      result.pv = tokens.slice(i + 1);
      break;
    }
  }

  // If there's no useful data (sometimes Stockfish sends tiny info lines)
  const hasAny =
    result.depth !== null ||
    result.eval !== null ||
    (Array.isArray(result.pv) && result.pv.length > 0);

  if (!hasAny) return null;

  return result;
}
