// ─────────────────────────────────────────────────────────────────────────────
// Bomberman — pure game logic (no Nest / DB deps). Server-authoritative.
// Grid-based map; players move in continuous tile coordinates; bombs explode
// after a fuse into cross-shaped flames that destroy bricks, chain other bombs
// and kill players. Destroyed bricks may drop power-ups.
// ─────────────────────────────────────────────────────────────────────────────

export enum Tile {
  EMPTY = 0,
  WALL = 1, // indestructible
  BRICK = 2, // destructible
}

export type PowerType = "BOMB" | "FLAME" | "SPEED";

export interface PlayerInput {
  // -1 | 0 | 1 on each axis (last pressed direction wins, set by gateway).
  dx: number;
  dy: number;
}

export interface BPlayer {
  userId: string;
  seat: number; // 0..3, also spawn corner
  x: number; // continuous tile coords (center)
  y: number;
  alive: boolean;
  // stats
  maxBombs: number;
  flame: number;
  speed: number; // tiles / second
  // runtime
  bombsOut: number;
  input: PlayerInput;
  diedAt?: number; // server time (ms) of death → for placement ordering
  // tracks the bomb tile the player is currently standing on (so they can step off it)
  standingBomb?: string | null;
}

export interface Bomb {
  id: string;
  ownerId: string;
  col: number;
  row: number;
  flame: number; // explosion range when this bomb was placed
  fuseAt: number; // server time (ms) when it detonates
}

export interface Flame {
  col: number;
  row: number;
  until: number; // server time (ms) when it disappears
}

export interface PowerUp {
  col: number;
  row: number;
  type: PowerType;
}

export interface BombermanState {
  cols: number;
  rows: number;
  grid: Tile[]; // flat rows*cols
  players: BPlayer[];
  bombs: Bomb[];
  flames: Flame[];
  powerups: PowerUp[];
  startedAt: number;
  finished: boolean;
  // seat order of death (first dead = last place). Winner (last alive) appended last.
  deathOrder: number[];
}

// ── Tunables ─────────────────────────────────────────────────────────────────
export const FUSE_MS = 2200; // bomb fuse
export const FLAME_MS = 600; // how long flames linger
export const PLAYER_RADIUS = 0.34; // half-size for AABB collision
export const BASE_SPEED = 4.2; // tiles / sec
export const SPEED_STEP = 0.9;
export const MAX_SPEED = 8;
export const START_BOMBS = 1;
export const START_FLAME = 2;
export const MAX_BOMBS = 8;
export const MAX_FLAME = 9;
export const POWERUP_DROP_CHANCE = 0.42;

// Spawn corners per seat (col,row) — filled in relative to map size.
function spawnCorners(cols: number, rows: number): Array<{ col: number; row: number }> {
  return [
    { col: 1, row: 1 },
    { col: cols - 2, row: rows - 2 },
    { col: cols - 2, row: 1 },
    { col: 1, row: rows - 2 },
  ];
}

export function idx(state: { cols: number }, col: number, row: number): number {
  return row * state.cols + col;
}

export function tileAt(state: BombermanState, col: number, row: number): Tile {
  if (col < 0 || row < 0 || col >= state.cols || row >= state.rows) return Tile.WALL;
  return state.grid[row * state.cols + col];
}

// ── Maps ─────────────────────────────────────────────────────────────────────
// Each map is a template string grid: '#'=wall, '.'=empty, ','=brick candidate,
// ' '=forced empty (kept clear, e.g. spawn safe zones). Odd-indexed inner cells
// are pillars (walls) in classic style; templates can override.

export interface MapDef {
  id: string;
  name: string;
  cols: number;
  rows: number;
  // brick density 0..1 for random fill on '.' cells
  brickDensity: number;
  // optional fixed layout (overrides procedural). Lines of equal length.
  layout?: string[];
}

export const MAPS: MapDef[] = [
  {
    id: "classic",
    name: "Cổ Điển",
    cols: 13,
    rows: 11,
    brickDensity: 0.72,
  },
  {
    id: "arena",
    name: "Đấu Trường",
    cols: 15,
    rows: 13,
    brickDensity: 0.6,
  },
  {
    id: "cross",
    name: "Thập Tự",
    cols: 13,
    rows: 11,
    brickDensity: 0.55,
    layout: [
      "#############",
      "#...........#",
      "#.#.#.#.#.#.#",
      "#...........#",
      "#.#.#.###.#.#",
      "#.....#.....#",
      "#.#.#.###.#.#",
      "#...........#",
      "#.#.#.#.#.#.#",
      "#...........#",
      "#############",
    ],
  },
  {
    id: "maze",
    name: "Mê Cung",
    cols: 15,
    rows: 13,
    brickDensity: 0.5,
    layout: [
      "###############",
      "#.....#.#.....#",
      "#.###.#.#.###.#",
      "#.#.......#.#.#",
      "#.#.##.##.#.#.#",
      "#.....#.#.....#",
      "##.##.#.#.##.##",
      "#.....#.#.....#",
      "#.#.##.##.#.#.#",
      "#.#.......#.#.#",
      "#.###.#.#.###.#",
      "#.....#.#.....#",
      "###############",
    ],
  },
];

export function getMap(id?: string): MapDef {
  return MAPS.find((m) => m.id === id) || MAPS[0];
}

// Cells around each spawn corner that must stay clear (so players aren't boxed in).
function isSpawnSafe(col: number, row: number, cols: number, rows: number): boolean {
  for (const c of spawnCorners(cols, rows)) {
    const d = Math.abs(c.col - col) + Math.abs(c.row - row);
    if (d <= 1) return true; // the corner + its 4-neighbours
  }
  return false;
}

let _seq = 0;
function nextId(prefix: string): string {
  _seq = (_seq + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

/** Builds a fresh game state for `playerIds` on the given map. */
export function createState(mapId: string, playerIds: string[], now: number): BombermanState {
  const def = getMap(mapId);
  const { cols, rows } = def;
  const grid: Tile[] = new Array(cols * rows).fill(Tile.EMPTY);

  if (def.layout) {
    for (let r = 0; r < rows; r++) {
      const line = def.layout[r] || "";
      for (let c = 0; c < cols; c++) {
        const ch = line[c] || "#";
        grid[r * cols + c] = ch === "#" ? Tile.WALL : Tile.EMPTY;
      }
    }
    // sprinkle bricks on empty, non-spawn cells
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (grid[i] === Tile.EMPTY && !isSpawnSafe(c, r, cols, rows) && Math.random() < def.brickDensity * 0.6) {
          grid[i] = Tile.BRICK;
        }
      }
    }
  } else {
    // Procedural classic: border walls, pillar grid on even/even, bricks elsewhere.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const border = c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
        const pillar = c % 2 === 0 && r % 2 === 0;
        if (border || pillar) {
          grid[i] = Tile.WALL;
        } else if (!isSpawnSafe(c, r, cols, rows) && Math.random() < def.brickDensity) {
          grid[i] = Tile.BRICK;
        }
      }
    }
  }

  const corners = spawnCorners(cols, rows);
  const players: BPlayer[] = playerIds.map((userId, seat) => {
    const c = corners[seat % corners.length];
    return {
      userId,
      seat,
      x: c.col,
      y: c.row,
      alive: true,
      maxBombs: START_BOMBS,
      flame: START_FLAME,
      speed: BASE_SPEED,
      bombsOut: 0,
      input: { dx: 0, dy: 0 },
      standingBomb: null,
    };
  });

  return {
    cols,
    rows,
    grid,
    players,
    bombs: [],
    flames: [],
    powerups: [],
    startedAt: now,
    finished: false,
    deathOrder: [],
  };
}

// ── Movement ─────────────────────────────────────────────────────────────────
// Axis-separated movement with AABB-vs-tile collision. Players can't walk
// through walls/bricks/bombs (except the bomb tile they're currently standing on).

function blocked(state: BombermanState, col: number, row: number, player: BPlayer): boolean {
  const t = tileAt(state, col, row);
  if (t === Tile.WALL || t === Tile.BRICK) return true;
  const key = `${col},${row}`;
  const bomb = state.bombs.find((b) => b.col === col && b.row === row);
  if (bomb) {
    // Allow standing on / stepping off the bomb you just placed.
    if (player.standingBomb === key) return false;
    return true;
  }
  return false;
}

function collideAxis(
  state: BombermanState,
  player: BPlayer,
  nx: number,
  ny: number,
): { x: number; y: number } {
  const r = PLAYER_RADIUS;
  // Check the tiles the AABB would overlap.
  const minC = Math.floor(nx - r);
  const maxC = Math.floor(nx + r);
  const minR = Math.floor(ny - r);
  const maxR = Math.floor(ny + r);
  for (let c = minC; c <= maxC; c++) {
    for (let rr = minR; rr <= maxR; rr++) {
      if (blocked(state, c, rr, player)) {
        return { x: player.x, y: player.y }; // reject move on collision
      }
    }
  }
  return { x: nx, y: ny };
}

/** Advances one player by dt seconds based on their current input. */
export function movePlayer(state: BombermanState, player: BPlayer, dt: number): void {
  if (!player.alive) return;
  const { dx, dy } = player.input;
  if (dx === 0 && dy === 0) return;

  // Update "standing bomb" tracking: once the player leaves the bomb tile, lock it.
  const curCol = Math.round(player.x);
  const curRow = Math.round(player.y);
  if (player.standingBomb) {
    const [bc, br] = player.standingBomb.split(",").map(Number);
    if (curCol !== bc || curRow !== br) player.standingBomb = null;
  }

  const dist = player.speed * dt;
  // Move one axis at a time for smooth wall-sliding.
  if (dx !== 0) {
    const moved = collideAxis(state, player, player.x + dx * dist, player.y);
    player.x = moved.x;
    if (moved.x === player.x) {
      // try to "snap" to row center to slip around corners
      const snapped = snapAxis(state, player, "y");
      if (snapped) player.y = snapped;
    }
  }
  if (dy !== 0) {
    const moved = collideAxis(state, player, player.x, player.y + dy * dist);
    player.y = moved.y;
    if (moved.y === player.y) {
      const snapped = snapAxis(state, player, "x");
      if (snapped) player.x = snapped;
    }
  }
}

// Gentle auto-align so players can turn into corridors without pixel-perfect aim.
function snapAxis(state: BombermanState, player: BPlayer, axis: "x" | "y"): number | null {
  const v = player[axis];
  const target = Math.round(v);
  if (Math.abs(v - target) < 0.001) return null;
  const step = Math.sign(target - v) * Math.min(0.15, Math.abs(target - v));
  const test = axis === "x"
    ? collideAxis(state, player, player.x + step, player.y)
    : collideAxis(state, player, player.x, player.y + step);
  const moved = axis === "x" ? test.x !== player.x : test.y !== player.y;
  return moved ? player[axis] + step : null;
}

// ── Bombs ────────────────────────────────────────────────────────────────────
/** Attempts to place a bomb at the player's current tile. Returns the bomb or null. */
export function placeBomb(state: BombermanState, player: BPlayer, now: number): Bomb | null {
  if (!player.alive) return null;
  if (player.bombsOut >= player.maxBombs) return null;
  const col = Math.round(player.x);
  const row = Math.round(player.y);
  if (tileAt(state, col, row) !== Tile.EMPTY) return null;
  if (state.bombs.some((b) => b.col === col && b.row === row)) return null;

  const bomb: Bomb = {
    id: nextId("b"),
    ownerId: player.userId,
    col,
    row,
    flame: player.flame,
    fuseAt: now + FUSE_MS,
  };
  state.bombs.push(bomb);
  player.bombsOut++;
  player.standingBomb = `${col},${row}`; // allow stepping off
  return bomb;
}

export interface ExplosionResult {
  detonated: Bomb[];
  destroyedBricks: Array<{ col: number; row: number; drop?: PowerType }>;
  killedSeats: number[]; // seats killed by these explosions
}

/** Detonates a bomb and any bombs caught in its flames (chain reaction). */
function detonate(state: BombermanState, bomb: Bomb, now: number, out: ExplosionResult): void {
  if (out.detonated.includes(bomb)) return;
  out.detonated.push(bomb);

  const owner = state.players.find((p) => p.userId === bomb.ownerId);
  if (owner && owner.bombsOut > 0) owner.bombsOut--;

  const addFlame = (col: number, row: number) => {
    state.flames.push({ col, row, until: now + FLAME_MS });
    // chain other bombs
    const chained = state.bombs.find((b) => b !== bomb && b.col === col && b.row === row && !out.detonated.includes(b));
    if (chained) detonate(state, chained, now, out);
  };

  // center
  addFlame(bomb.col, bomb.row);

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dc, dr] of dirs) {
    for (let step = 1; step <= bomb.flame; step++) {
      const c = bomb.col + dc * step;
      const r = bomb.row + dr * step;
      const t = tileAt(state, c, r);
      if (t === Tile.WALL) break;
      if (t === Tile.BRICK) {
        state.grid[r * state.cols + c] = Tile.EMPTY;
        const drop = Math.random() < POWERUP_DROP_CHANCE ? randomPower() : undefined;
        if (drop) state.powerups.push({ col: c, row: r, type: drop });
        out.destroyedBricks.push({ col: c, row: r, drop });
        break; // flame stops at the first brick
      }
      addFlame(c, r);
    }
  }
}

function randomPower(): PowerType {
  const r = Math.random();
  if (r < 0.4) return "BOMB";
  if (r < 0.8) return "FLAME";
  return "SPEED";
}

/**
 * Processes the world for the current tick: explode due bombs, expire flames,
 * pick up power-ups, and kill players standing in flames. Returns what changed
 * so the gateway can emit fine-grained events (explosions, deaths, pickups).
 */
export function tickWorld(state: BombermanState, now: number): {
  explosion: ExplosionResult | null;
  pickups: Array<{ seat: number; type: PowerType }>;
  deaths: number[];
} {
  let explosion: ExplosionResult | null = null;

  // 1) detonate due bombs (+ chains)
  const due = state.bombs.filter((b) => b.fuseAt <= now);
  if (due.length) {
    const res: ExplosionResult = { detonated: [], destroyedBricks: [], killedSeats: [] };
    for (const b of due) detonate(state, b, now, res);
    // remove detonated bombs
    state.bombs = state.bombs.filter((b) => !res.detonated.includes(b));
    explosion = res;
  }

  // 2) expire old flames
  state.flames = state.flames.filter((f) => f.until > now);

  // 3) power-up pickups
  const pickups: Array<{ seat: number; type: PowerType }> = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    const col = Math.round(p.x);
    const row = Math.round(p.y);
    const pi = state.powerups.findIndex((u) => u.col === col && u.row === row);
    if (pi >= 0) {
      const pu = state.powerups[pi];
      applyPower(p, pu.type);
      state.powerups.splice(pi, 1);
      pickups.push({ seat: p.seat, type: pu.type });
    }
  }

  // 4) deaths — any alive player whose tile is on fire dies
  const deaths: number[] = [];
  for (const p of state.players) {
    if (!p.alive) continue;
    const col = Math.round(p.x);
    const row = Math.round(p.y);
    const onFire = state.flames.some((f) => f.col === col && f.row === row);
    if (onFire) {
      p.alive = false;
      p.diedAt = now;
      deaths.push(p.seat);
      if (!state.deathOrder.includes(p.seat)) state.deathOrder.push(p.seat);
    }
  }

  return { explosion, pickups, deaths };
}

function applyPower(p: BPlayer, type: PowerType): void {
  if (type === "BOMB") p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
  else if (type === "FLAME") p.flame = Math.min(MAX_FLAME, p.flame + 1);
  else if (type === "SPEED") p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
}

/** Players still alive. */
export function aliveCount(state: BombermanState): number {
  return state.players.filter((p) => p.alive).length;
}

/**
 * Final placement (seat -> rank, 1 = best). Last survivor is 1st; others ranked
 * by reverse death order (later death = better placement).
 */
export function placements(state: BombermanState): Map<number, number> {
  const survivors = state.players.filter((p) => p.alive).map((p) => p.seat);
  // death order: first dead is worst. Build best→worst seat list.
  const order: number[] = [...survivors, ...[...state.deathOrder].reverse()];
  const map = new Map<number, number>();
  order.forEach((seat, i) => map.set(seat, i + 1));
  // any seat not covered (shouldn't happen) gets last
  state.players.forEach((p) => {
    if (!map.has(p.seat)) map.set(p.seat, state.players.length);
  });
  return map;
}
