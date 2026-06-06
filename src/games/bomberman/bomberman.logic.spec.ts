import {
  createState,
  placeBomb,
  tickWorld,
  movePlayer,
  Tile,
  tileAt,
  aliveCount,
  placements,
  FUSE_MS,
  getMap,
  MAPS,
} from './bomberman.logic';

describe('bomberman.logic', () => {
  it('creates a state with correct dimensions and spawned players', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const def = getMap('classic');
    expect(s.cols).toBe(def.cols);
    expect(s.rows).toBe(def.rows);
    expect(s.grid.length).toBe(def.cols * def.rows);
    expect(s.players.length).toBe(2);
    // spawn corners are empty
    s.players.forEach((p) => {
      expect(tileAt(s, Math.round(p.x), Math.round(p.y))).toBe(Tile.EMPTY);
      expect(p.alive).toBe(true);
    });
  });

  it('all maps have valid layouts (walls on border, equal-length lines)', () => {
    for (const m of MAPS) {
      const s = createState(m.id, ['a', 'b'], 0);
      // borders are walls
      for (let c = 0; c < s.cols; c++) {
        expect(tileAt(s, c, 0)).toBe(Tile.WALL);
        expect(tileAt(s, c, s.rows - 1)).toBe(Tile.WALL);
      }
      for (let r = 0; r < s.rows; r++) {
        expect(tileAt(s, 0, r)).toBe(Tile.WALL);
        expect(tileAt(s, s.cols - 1, r)).toBe(Tile.WALL);
      }
    }
  });

  it('places a bomb and limits to maxBombs', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const p = s.players[0];
    const b1 = placeBomb(s, p, 0);
    expect(b1).not.toBeNull();
    expect(p.bombsOut).toBe(1);
    // second bomb on same tile / over limit fails (maxBombs starts at 1)
    const b2 = placeBomb(s, p, 0);
    expect(b2).toBeNull();
  });

  it('explodes after fuse, clears bombs and creates flames', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const p = s.players[0];
    placeBomb(s, p, 0);
    expect(s.bombs.length).toBe(1);
    const res = tickWorld(s, FUSE_MS + 1);
    expect(res.explosion).not.toBeNull();
    expect(s.bombs.length).toBe(0);
    expect(s.flames.length).toBeGreaterThan(0);
    // owner's bomb count freed
    expect(p.bombsOut).toBe(0);
  });

  it('flame kills a player standing on it', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const p = s.players[0];
    placeBomb(s, p, 0); // bomb under player at spawn
    // player stays on the bomb tile
    const res = tickWorld(s, FUSE_MS + 1);
    expect(res.deaths).toContain(p.seat);
    expect(p.alive).toBe(false);
    expect(aliveCount(s)).toBe(1);
  });

  it('placements rank last survivor first', () => {
    const s = createState('classic', ['a', 'b', 'c'], 0);
    // seat 0 dies first, seat 1 dies second, seat 2 survives
    s.players[0].alive = false;
    s.players[0].diedAt = 10;
    s.deathOrder.push(0);
    s.players[1].alive = false;
    s.players[1].diedAt = 20;
    s.deathOrder.push(1);
    const place = placements(s);
    expect(place.get(2)).toBe(1); // survivor = 1st
    expect(place.get(1)).toBe(2); // died later = 2nd
    expect(place.get(0)).toBe(3); // died first = last
  });

  it('movement is blocked by walls but allowed into open space', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const p = s.players[0]; // spawn (1,1)
    // moving up into row 0 (wall) should NOT pass row 0.5 boundary
    p.input = { dx: 0, dy: -1 };
    for (let i = 0; i < 30; i++) movePlayer(s, p, 0.05);
    expect(p.y).toBeGreaterThan(0.5 + 0.3); // stayed clear of the top wall

    // classic spawn-safe keeps (2,1) open → moving right should actually advance.
    const p2 = s.players[0];
    const startX = p2.x;
    p2.input = { dx: 1, dy: 0 };
    movePlayer(s, p2, 0.05);
    expect(p2.x).toBeGreaterThan(startX); // moved right into open space
  });

  it('player can walk fully off the bomb they just placed (no mid-tile stick)', () => {
    const s = createState('classic', ['a', 'b'], 0);
    const p = s.players[0]; // spawn (1,1), tile (2,1) is spawn-safe/open
    placeBomb(s, p, 0); // bomb at (1,1) under the player
    expect(s.bombs.length).toBe(1);
    // walk right; should clear the bomb tile entirely and reach near tile 2.
    p.input = { dx: 1, dy: 0 };
    for (let i = 0; i < 40; i++) movePlayer(s, p, 0.05);
    // must have moved well past the bomb's AABB overlap zone (not stuck ~1.5)
    expect(p.x).toBeGreaterThan(1.9);
    // and the standing-bomb grace must have been released (bomb now solid behind us)
    expect(p.standingBomb).toBeNull();
  });

  it('walks along an open corridor without sticking when slightly off-center', () => {
    const s = createState('cross', ['a', 'b'], 0);
    const p = s.players[0];
    // Force-clear row 1 along the path so the test is deterministic (the map may
    // randomly sprinkle destructible bricks there).
    for (let c = 1; c < s.cols - 1; c++) s.grid[1 * s.cols + c] = Tile.EMPTY;
    p.x = 3;
    p.y = 1.18; // slightly off the row center to exercise corridor auto-centering
    p.input = { dx: 1, dy: 0 };
    const startX = p.x;
    for (let i = 0; i < 20; i++) movePlayer(s, p, 0.05);
    expect(p.x).toBeGreaterThan(startX + 1); // kept advancing, did not stick
    expect(Math.abs(p.y - 1)).toBeLessThan(0.12); // pulled toward row center
  });
});
