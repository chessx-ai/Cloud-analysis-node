# Stockfish Socket Service (Node.js + Socket.IO)

A production-friendly **Stockfish chess analysis** service built with **Node.js**, **Express**, and **Socket.IO**.

This server runs **one Stockfish engine process per socket connection** and streams analysis updates to clients.

✅ MultiPV support  
✅ Optional grouped MultiPV output for easy usage  
✅ Optional smart/throttled updates to reduce WebSocket traffic  
✅ Server-side clamping/limits to prevent CPU/RAM abuse  
✅ Depth or Movetime analysis modes  

---

## Features

- **Stockfish UCI engine** integration via Node child process
- **Socket.IO real-time streaming** of `info` updates
- Supports:
  - Depth-based analysis (`go depth N`)
  - Time-based analysis (`go movetime N`)
- **MultiPV** mode (top N candidate lines)
- **Eval normalization**:
  - from White’s perspective (`evalView: "white"`)
  - from side-to-move (`evalView: "turn"`)
- **Smart update mode** (optional) to reduce WebSocket spam:
  - throttling + diff-based emitting
- **Optional grouped PV output** (`groupPv: true`) → `{ lines: {1:...,2:...} }`
- Limits/clamping to protect server resources

---

## Requirements

- Node.js **18+** recommended
- Stockfish installed and accessible from your server
  - Linux: `sudo apt install stockfish`
  - macOS: `brew install stockfish`
  - Windows: download a Stockfish executable and set `STOCKFISH_PATH`

---

## Installation

```sh
npm install
```

## Environment Variables

#### Create a .env file:

```sh
PORT=3000

# Stockfish executable path
STOCKFISH_PATH=stockfish

# Default engine config (used if client doesn't override)
ENGINE_THREADS=1
ENGINE_HASH_MB=64
ENGINE_MULTIPV=1

# Hard caps (client requests above this are clamped)
MAX_ENGINE_THREADS=2
MAX_ENGINE_HASH_MB=128
MAX_ENGINE_MULTIPV=3

# Analysis hard caps (prevents abusive depth/time requests)
MAX_DEPTH=30
MAX_MOVETIME_MS=15000

# Concurrency protection
MAX_ENGINES=3
MAX_ACTIVE_ANALYSIS=2
```

## Run
```sh
npm run start
```
#### or
```sh
npm run dev
```

## Health Check
`GET /`

#### Returns current server status:
```sh
{
  "ok": true,
  "service": "Stockfish Socket Service",
  "connectedEngines": 1,
  "activeAnalysisCount": 0,
  "defaults": {
    "threads": 1,
    "hashMb": 64,
    "multiPv": 1
  },
  "limits": {
    "engine": {
      "maxThreads": 2,
      "maxHashMb": 128,
      "maxMultiPv": 3
    },
    "analysis": {
      "maxDepth": 30,
      "maxMovetimeMs": 15000
    }
  },
  "time": "2026-01-21T00:00:00.000Z"
}
```
## Socket Events API

### `engine:ready`

#### Server → Client

Sent when engine is initialized.

#### ✅ Success:

 ```sh
 {
  "ok": true,
  "defaults": {
    "threads": 1,
    "hashMb": 64,
    "multiPv": 1
  },
  "limits": {
    "maxThreads": 2,
    "maxHashMb": 128,
    "maxMultiPv": 3,
    "maxDepth": 30,
    "maxMovetimeMs": 15000
  }
}
```

#### ❌ Failure:

```sh
{
  "ok": false,
  "message": "Server busy (engine limit reached). Try again later."
}
```
### `analysis:start`

#### Client → Server
Starts analysis.

#### Payload Schema (Full)

```sh
{
  "fen": "string",
  "mode": "depth | time",
  "value": 18,

  "evalView": "white | turn",

  "threads": 1,
  "hashMb": 64,
  "multiPv": 3,

  "groupPv": false,

  "smartUpdates": false,
  "minIntervalMs": 120,
  "evalDelta": 0.15,
  "depthStep": 1
}
```

#### Required Fields

- `fen` (string)
- `mode` ("`depth`" or "`time`")
- `value` (number)

#### Optional Fields

#### Engine tuning (clamped)

- `threads`: `1..MAX_ENGINE_THREADS`
- `hashMb`: `16..MAX_ENGINE_HASH_MB`
- `multiPv`: `1..MAX_ENGINE_MULTIPV`

#### Grouping option

- `groupPv` (boolean): when enabled, server sends `analysis:updateGrouped`

#### Smart updates (traffic reduction)
- `smartUpdates` (boolean)
- `minIntervalMs` (number)
- `evalDelta` (number)
- `depthStep` (number)

### `analysis:started`

#### Server → Client

Sent when analysis starts.

```sh
{
  "ok": true,
  "fen": "string",
  "mode": "depth",
  "value": 18,
  "evalView": "white",
  "engine": {
    "threads": 2,
    "hashMb": 128,
    "multiPv": 3
  },
  "options": {
    "groupPv": true,
    "smartUpdates": true,
    "minIntervalMs": 120,
    "evalDelta": 0.15,
    "depthStep": 1
  },
  "clamped": {
    "valueWasClamped": false,
    "threadsWasClamped": false,
    "hashWasClamped": false,
    "multiPvWasClamped": false
  }
}

```

### `analysis:update`

#### Server → Client
 
 Emitted only when `groupPv: false`.

 ```sh
 {
  "depth": 18,
  "selDepth": 24,
  "multiPv": 1,

  "evalType": "cp",
  "eval": 0.45,

  "pv": ["e2e4", "e7e5", "g1f3"],

  "timeMs": 1234,
  "nodes": 1234567,
  "nps": 900000,
  "hashFull": 450,

  "evalView": "white",
  "turn": "w"
}

 ```

 #### Notes
 - `evalType` can be `"cp"` or `"mate"`
 - `eval` is a number:
   - cp score converted from centipawns to pawn units (depending on your normalize function)
   - mate score as integer (e.g. `mate 3`)

### `analysis:updateGrouped`

#### Server → Client

Emitted only when `groupPv: true`.
```sh
{
  "fen": "string",
  "lines": {
    "1": {
      "depth": 18,
      "multiPv": 1,
      "evalType": "cp",
      "eval": 0.22,
      "pv": ["e2e4", "e7e5"]
    },
    "2": {
      "depth": 18,
      "multiPv": 2,
      "evalType": "cp",
      "eval": 0.11,
      "pv": ["d2d4", "d7d5"]
    }
  }
}

```

### `analysis:done`

#### Server → Client

Sent when Stockfish outputs `bestmove`.

```sh
{
  "bestMove": "e2e4",
  "grouped": null
}

```
If `groupPv: true`, grouped results may be included:

```sh
{
  "bestMove": "e2e4",
  "grouped": {
    "fen": "string",
    "lines": {
      "1": { "...latest info..." },
      "2": { "...latest info..." }
    }
  }
}

```

### `analysis:stop`

#### Client → Server

Stops analysis manually.

No payload required:

```sh
socket.emit("analysis:stop");
```

### `analysis:stopped`

#### Server → Client

```sh
{
  "ok": true
}

```

### `analysis:error`

#### Server → Client
```sh
{
  "message": "Error description..."
}

```

## Smart Updates (Traffic Reduction)

When `smartUpdates: true`:
- server throttles update frequency

- server only emits when meaningful changes occur:
  - depth increases by `depthStep`
  - eval changes by at least `evalDelta`
  - pv changes

#### Recommended Defaults
 - `minIntervalMs`: 120–250
 - `evalDelta`: 0.15–0.30
 - `depthStep`: 1–2


## MultiPV Grouping
When `groupPv: true`, updates are sent as:

```sh
{
  "fen": "string",
  "lines": {
    "1": { "multiPv": 1, "...": "..." },
    "2": { "multiPv": 2, "...": "..." }
  }
}
 ```

This makes rendering easier:
 - no manual sorting by multipv
 - easier to show top-N lines in UI

## Notes

- Some Stockfish builds output analysis info on stderr.
  Ensure your engine reads both stdout and stderr.
- For best results, use a modern Stockfish binary (Stockfish 15+).
- If you plan to deploy publicly, consider:
  - per-IP rate limiting
  - authentication tokens
  - queueing system for analysis
