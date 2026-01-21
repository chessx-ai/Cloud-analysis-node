import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseUciInfoLine } from "./parseUci.js";
import { getTurnFromFen, normalizeEvalToWhitePerspective } from "./utils.js";

export class StockfishEngine {
  constructor({ path, threads = 1, hashMb = 64, multiPv = 1 }) {
    this.path = path;

    this.threads = threads;
    this.hashMb = hashMb;
    this.multiPv = multiPv;

    this.process = null;

    this.rlOut = null;
    this.rlErr = null;

    this.isReady = false;
    this.isAnalyzing = false;

    this.currentFen = null;
    this.evalView = "white";

    this.lastMode = "depth";

    this.onInfo = null;
    this.onBestMove = null;
    this.onError = null;
    this.onExit = null;
  }

  async init() {
    if (this.process) return;

    this.process = spawn(this.path, [], {
      stdio: ["pipe", "pipe", "pipe"], // ✅ keep stderr as pipe too
    });

    this.process.on("error", (err) => {
      this.onError?.(err);
    });

    this.process.on("exit", (code, signal) => {
      this.isReady = false;
      this.isAnalyzing = false;
      this.onExit?.({ code, signal });
    });

    /**
     * ✅ Listen to stdout
     */
    this.rlOut = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    this.rlOut.on("line", (line) => {
      this.#handleLine(line);
    });

    /**
     * ✅ Listen to stderr as well (very important on some builds)
     */
    this.rlErr = readline.createInterface({
      input: this.process.stderr,
      crlfDelay: Infinity,
    });

    this.rlErr.on("line", (line) => {
      this.#handleLine(line);
    });

    // Init UCI
    this.send("uci");

    await this.setOptions({
      threads: this.threads,
      hashMb: this.hashMb,
      multiPv: this.multiPv,
    });

    this.send("isready");
    await this.#waitForReadyOk();
  }

  async setOptions({ threads, hashMb, multiPv } = {}) {
    if (!this.process) throw new Error("Engine not initialized");

    if (this.isAnalyzing) {
      await this.stop();
    }

    if (typeof threads === "number" && Number.isFinite(threads) && threads > 0) {
      this.threads = threads;
      this.send(`setoption name Threads value ${threads}`);
    }

    if (typeof hashMb === "number" && Number.isFinite(hashMb) && hashMb > 0) {
      this.hashMb = hashMb;
      this.send(`setoption name Hash value ${hashMb}`);
    }

    if (typeof multiPv === "number" && Number.isFinite(multiPv) && multiPv > 0) {
      this.multiPv = multiPv;
      this.send(`setoption name MultiPV value ${multiPv}`);
    }

    this.isReady = false;
    this.send("isready");
    await this.#waitForReadyOk();
  }

  async analyze({ fen, mode, value, evalView = "white" }) {
    if (!this.process) throw new Error("Engine not initialized");

    if (!fen || typeof fen !== "string") throw new Error("Invalid FEN");
    if (mode !== "depth" && mode !== "time") {
      throw new Error('Invalid mode. Use "depth" or "time".');
    }
    if (typeof value !== "number" || value <= 0) {
      throw new Error("Value must be positive number");
    }
    if (evalView !== "white" && evalView !== "turn") {
      throw new Error('Invalid evalView. Use "white" or "turn".');
    }

    this.lastMode = mode;

    await this.stop();

    this.currentFen = fen;
    this.evalView = evalView;
    this.isAnalyzing = true;

    this.send("ucinewgame");
    this.send("isready");
    await this.#waitForReadyOk();

    this.send(`position fen ${fen}`);

    if (mode === "depth") {
      this.send(`go depth ${value}`);
    } else {
      this.send(`go movetime ${value}`);
    }
  }

  async stop() {
    if (!this.process) return;
    if (!this.isAnalyzing) return;

    this.send("stop");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async quit() {
    if (!this.process) return;

    try {
      this.send("quit");
    } catch {}

    this.rlOut?.close();
    this.rlErr?.close();

    this.process.kill();

    this.process = null;
    this.rlOut = null;
    this.rlErr = null;

    this.isReady = false;
    this.isAnalyzing = false;
  }

  send(command) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(command.trim() + "\n");
  }

  #handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // ✅ readyok
    if (trimmed === "readyok") {
      this.isReady = true;
      return;
    }

    // ✅ parse info line
    const info = parseUciInfoLine(trimmed);
    if (info) {
      const fen = this.currentFen;
      const turn = fen ? getTurnFromFen(fen) : "w";

      let normalizedEval = info.eval;

      if (this.evalView === "white") {
        normalizedEval = normalizeEvalToWhitePerspective({
          evalType: info.evalType,
          evalValue: info.eval,
          turn,
        });
      }

      this.onInfo?.({
        ...info,
        eval: normalizedEval,
        evalView: this.evalView,
        turn,
      });

      return;
    }

    // ✅ bestmove
    if (trimmed.startsWith("bestmove")) {
      this.isAnalyzing = false;

      const parts = trimmed.split(/\s+/);
      const bestMove = parts[1] || null;

      this.onBestMove?.({ bestMove, raw: trimmed });
      return;
    }
  }

  async #waitForReadyOk(timeoutMs = 2000) {
    const start = Date.now();
    if (this.isReady) return;

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.isReady) {
          clearInterval(interval);
          resolve();
          return;
        }

        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error("Timeout waiting for Stockfish readyok"));
        }
      }, 20);
    });
  }
}
