import express from "express";
import http from "http";
import "dotenv/config";
import { Server } from "socket.io";
import { StockfishEngine } from "./stockfish/stockfishEngine.js";

const PORT = process.env.PORT || 3000;

/**
 * Default engine settings (used if client does not send overrides)
 */
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "stockfish";
const DEFAULT_ENGINE_THREADS = Number(process.env.ENGINE_THREADS || 1);
const DEFAULT_ENGINE_HASH_MB = Number(process.env.ENGINE_HASH_MB || 64);
const DEFAULT_ENGINE_MULTIPV = Number(process.env.ENGINE_MULTIPV || 1);

/**
 * Hard engine limits (server protection)
 * Any client values above this will be clamped (not rejected)
 */
const MAX_ENGINE_THREADS = Number(process.env.MAX_ENGINE_THREADS || 2);
const MAX_ENGINE_HASH_MB = Number(process.env.MAX_ENGINE_HASH_MB || 128);
const MAX_ENGINE_MULTIPV = Number(process.env.MAX_ENGINE_MULTIPV || 3);

/**
 * Analysis safety limits (prevents abusive depth/time)
 */
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 30);
const MAX_MOVETIME_MS = Number(process.env.MAX_MOVETIME_MS || 15000);

/**
 * Server concurrency protection
 */
const MAX_ENGINES = Number(process.env.MAX_ENGINES || 3);
const MAX_ACTIVE_ANALYSIS = Number(process.env.MAX_ACTIVE_ANALYSIS || 2);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

let connectedEngines = 0;
let activeAnalysisCount = 0;

/**
 * Clamp a numeric value to [min, max].
 */
function clampNumber(value, { min, max, fallback }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

/**
 * Timestamp helper
 */
function nowMs() {
  return Date.now();
}

/**
 * Compare PV arrays for changes
 */
function isPvChanged(prevPv, nextPv) {
  const a = prevPv || [];
  const b = nextPv || [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

/**
 * Dynamic throttle interval based on depth/mode
 * Higher depth = emit slower (less traffic, still useful updates)
 */
function getDynamicIntervalMs({ mode, depth }) {
  if (mode === "depth") {
    if (depth <= 6) return 80;
    if (depth <= 12) return 140;
    if (depth <= 18) return 220;
    return 350;
  }

  // movetime mode: stable rate
  return 180;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Stockfish Socket Service",
    connectedEngines,
    activeAnalysisCount,
    defaults: {
      threads: DEFAULT_ENGINE_THREADS,
      hashMb: DEFAULT_ENGINE_HASH_MB,
      multiPv: DEFAULT_ENGINE_MULTIPV,
    },
    limits: {
      engine: {
        maxThreads: MAX_ENGINE_THREADS,
        maxHashMb: MAX_ENGINE_HASH_MB,
        maxMultiPv: MAX_ENGINE_MULTIPV,
      },
      analysis: {
        maxDepth: MAX_DEPTH,
        maxMovetimeMs: MAX_MOVETIME_MS,
      },
    },
    time: new Date().toISOString(),
  });
});

io.on("connection", async (socket) => {
  console.log("✅ Client connected:", socket.id);

  /**
   * Limit number of engines at once
   */
  if (connectedEngines >= MAX_ENGINES) {
    socket.emit("engine:ready", {
      ok: false,
      message: "Server busy (engine limit reached). Try again later.",
    });
    socket.disconnect(true);
    return;
  }

  connectedEngines += 1;

  /**
   * Create engine for this client connection
   */
  const engine = new StockfishEngine({
    path: STOCKFISH_PATH,
    threads: DEFAULT_ENGINE_THREADS,
    hashMb: DEFAULT_ENGINE_HASH_MB,
    multiPv: DEFAULT_ENGINE_MULTIPV,
  });

  /**
   * Per-session analysis config (set during analysis:start)
   */
  let sessionConfig = {
    fen: null,

    // optional features
    groupPv: false,
    smartUpdates: false,

    // smart update tuning
    minIntervalMs: 120,
    evalDelta: 0.15,
    depthStep: 1,
  };

  /**
   * Grouped MultiPV state (only used when groupPv=true)
   */
  let groupedPvState = {
    fen: null,
    lines: {},
  };

  function resetGroupedPv(fen) {
    groupedPvState = {
      fen,
      lines: {},
    };
  }

  /**
   * Smart update state (only used when smartUpdates=true)
   */
  let lastEmitAt = 0;
  const lastSentByPv = new Map(); // key=multiPv, value=last emitted info

  /**
   * Engine callbacks
   */
  engine.onInfo = (info) => {
    if (!info.pv?.length && info.eval == null) {
      return; // skip useless traffic
    }

    /**
     * ✅ Default mode (no throttling)
     */
    if (!sessionConfig.smartUpdates) {
      if (!sessionConfig.groupPv) {
        socket.emit("analysis:update", info);
        return;
      }

      const mpv = info.multiPv || 1;
      groupedPvState.lines[mpv] = info;

      socket.emit("analysis:updateGrouped", {
        fen: groupedPvState.fen,
        lines: groupedPvState.lines,
      });
      return;
    }

    /**
     * ✅ SMART UPDATES MODE
     * Reduce websocket traffic using throttling + diff logic.
     */
    const mpv = info.multiPv || 1;
    const prev = lastSentByPv.get(mpv);

    const depth = typeof info.depth === "number" ? info.depth : 0;
    const evalScore = typeof info.eval === "number" ? info.eval : null;

    const dynamicInterval = getDynamicIntervalMs({
      mode: engine.lastMode || "depth",
      depth,
    });

    const interval = Math.max(sessionConfig.minIntervalMs, dynamicInterval);
    const t = nowMs();

    const timeOk = t - lastEmitAt >= interval;

    const depthOk =
      !prev ||
      (typeof prev.depth === "number" &&
        typeof info.depth === "number" &&
        info.depth >= prev.depth + sessionConfig.depthStep);

    const evalOk =
      !prev ||
      (evalScore !== null &&
        typeof prev.eval === "number" &&
        Math.abs(evalScore - prev.eval) >= sessionConfig.evalDelta);

    const pvOk = !prev || isPvChanged(prev.pv, info.pv);

    // Emit only if throttled AND meaningful change happened
    const shouldEmit = timeOk && (depthOk || evalOk || pvOk);
    if (!shouldEmit) return;

    lastEmitAt = t;
    lastSentByPv.set(mpv, info);

    if (!sessionConfig.groupPv) {
      socket.emit("analysis:update", info);
      return;
    }

    groupedPvState.lines[mpv] = info;
    socket.emit("analysis:updateGrouped", {
      fen: groupedPvState.fen,
      lines: groupedPvState.lines,
    });
  };

  engine.onBestMove = ({ bestMove }) => {
    if (activeAnalysisCount > 0) activeAnalysisCount -= 1;

    socket.emit("analysis:done", {
      bestMove,
      grouped: sessionConfig.groupPv ? groupedPvState : null,
    });
  };

  engine.onError = (err) => {
    console.error("❌ Stockfish error:", err);

    if (engine.isAnalyzing && activeAnalysisCount > 0) {
      activeAnalysisCount -= 1;
    }

    socket.emit("analysis:error", {
      message: err.message || "Stockfish engine error",
    });
  };

  engine.onExit = ({ code, signal }) => {
    console.log(`⚠️ Stockfish exited (code=${code}, signal=${signal})`);
  };

  /**
   * Init engine
   */
  try {
    await engine.init();
    socket.emit("engine:ready", {
      ok: true,
      defaults: {
        threads: DEFAULT_ENGINE_THREADS,
        hashMb: DEFAULT_ENGINE_HASH_MB,
        multiPv: DEFAULT_ENGINE_MULTIPV,
      },
      limits: {
        maxThreads: MAX_ENGINE_THREADS,
        maxHashMb: MAX_ENGINE_HASH_MB,
        maxMultiPv: MAX_ENGINE_MULTIPV,
        maxDepth: MAX_DEPTH,
        maxMovetimeMs: MAX_MOVETIME_MS,
      },
    });
  } catch (err) {
    console.error("❌ Failed to init Stockfish:", err);

    socket.emit("engine:ready", {
      ok: false,
      message: err.message,
    });
  }

  /**
   * analysis:start
   * payload:
   * {
   *   fen: string,
   *   mode: "depth" | "time",
   *   value: number,
   *   evalView?: "white" | "turn",
   *
   *   // tuning (optional)
   *   threads?: number,
   *   hashMb?: number,
   *   multiPv?: number,
   *
   *   // frontend convenience (optional)
   *   groupPv?: boolean,
   *
   *   // smart traffic reduction (optional)
   *   smartUpdates?: boolean,
   *   minIntervalMs?: number,
   *   evalDelta?: number,
   *   depthStep?: number
   * }
   */
  socket.on("analysis:start", async (payload) => {
    try {
      if (activeAnalysisCount >= MAX_ACTIVE_ANALYSIS) {
        socket.emit("analysis:error", {
          message: "Server busy (analysis limit reached). Try again later.",
        });
        return;
      }

      const {
        fen,
        mode,
        value,
        evalView = "white",

        // engine tuning (optional)
        threads,
        hashMb,
        multiPv,

        // optional features
        groupPv = false,

        // smart updates (optional)
        smartUpdates = false,
        minIntervalMs,
        evalDelta,
        depthStep,
      } = payload || {};

      /**
       * Clamp engine tuning
       */
      const safeThreads = clampNumber(threads, {
        min: 1,
        max: MAX_ENGINE_THREADS,
        fallback: DEFAULT_ENGINE_THREADS,
      });

      const safeHashMb = clampNumber(hashMb, {
        min: 16,
        max: MAX_ENGINE_HASH_MB,
        fallback: DEFAULT_ENGINE_HASH_MB,
      });

      const safeMultiPv = clampNumber(multiPv, {
        min: 1,
        max: MAX_ENGINE_MULTIPV,
        fallback: DEFAULT_ENGINE_MULTIPV,
      });

      /**
       * Clamp analysis request values (prevents abuse)
       */
      let safeMode = mode;
      let safeValue = value;

      if (safeMode === "depth") {
        safeValue = clampNumber(value, {
          min: 1,
          max: MAX_DEPTH,
          fallback: 12,
        });
      } else if (safeMode === "time") {
        safeValue = clampNumber(value, {
          min: 10,
          max: MAX_MOVETIME_MS,
          fallback: 500,
        });
      } else {
        throw new Error('Invalid mode. Use "depth" or "time".');
      }

      // Reserve an analysis slot
      activeAnalysisCount += 1;

      /**
       * Save analysis session preferences
       */
      sessionConfig = {
        fen,
        groupPv: Boolean(groupPv),
        smartUpdates: Boolean(smartUpdates),

        minIntervalMs:
          typeof minIntervalMs === "number" && minIntervalMs > 0
            ? minIntervalMs
            : 120,

        evalDelta:
          typeof evalDelta === "number" && evalDelta >= 0 ? evalDelta : 0.15,

        depthStep:
          typeof depthStep === "number" && depthStep > 0 ? depthStep : 1,
      };

      /**
       * Reset grouping + smart update states
       */
      if (sessionConfig.groupPv) {
        resetGroupedPv(fen);
      }

      lastEmitAt = 0;
      lastSentByPv.clear();

      /**
       * Apply engine settings
       */
      await engine.setOptions({
        threads: safeThreads,
        hashMb: safeHashMb,
        multiPv: safeMultiPv,
      });

      /**
       * Start analysis
       */
      await engine.analyze({
        fen,
        mode: safeMode,
        value: safeValue,
        evalView,
      });

      socket.emit("analysis:started", {
        ok: true,
        fen,
        mode: safeMode,
        value: safeValue,
        evalView,
        engine: {
          threads: safeThreads,
          hashMb: safeHashMb,
          multiPv: safeMultiPv,
        },
        options: {
          groupPv: sessionConfig.groupPv,
          smartUpdates: sessionConfig.smartUpdates,
          minIntervalMs: sessionConfig.minIntervalMs,
          evalDelta: sessionConfig.evalDelta,
          depthStep: sessionConfig.depthStep,
        },
        clamped: {
          valueWasClamped: safeValue !== value,
          threadsWasClamped: safeThreads !== Number(threads),
          hashWasClamped: safeHashMb !== Number(hashMb),
          multiPvWasClamped: safeMultiPv !== Number(multiPv),
        },
      });
    } catch (err) {
      // Release slot if failed
      if (activeAnalysisCount > 0) activeAnalysisCount -= 1;

      socket.emit("analysis:error", {
        message: err.message || "Failed to start analysis",
      });
    }
  });

  /**
   * analysis:stop
   */
  socket.on("analysis:stop", async () => {
    try {
      await engine.stop();

      if (activeAnalysisCount > 0) activeAnalysisCount -= 1;

      socket.emit("analysis:stopped", { ok: true });
    } catch (err) {
      socket.emit("analysis:error", {
        message: err.message || "Failed to stop analysis",
      });
    }
  });

  /**
   * Cleanup on disconnect
   */
  socket.on("disconnect", async () => {
    console.log("❌ Client disconnected:", socket.id);

    // Release slot if user disconnects mid-analysis
    if (engine.isAnalyzing && activeAnalysisCount > 0) {
      activeAnalysisCount -= 1;
    }

    connectedEngines -= 1;
    await engine.quit();
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Stockfish Socket Service running on port ${PORT}`);
});
