import {
  applyMove,
  Board,
  BOARD_SIZE,
  createBoard,
  findWinningLine,
  idx,
  inBounds,
  WIN_COUNT,
} from './caro.logic';

describe('caro board', () => {
  it('creates an empty 15x15 board', () => {
    const b = createBoard();
    expect(b.length).toBe(BOARD_SIZE * BOARD_SIZE);
    expect(b.every((c) => c === 0)).toBe(true);
  });

  it('idx and inBounds behave', () => {
    expect(idx(0, 0)).toBe(0);
    expect(idx(1, 0)).toBe(BOARD_SIZE);
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(-1, 0)).toBe(false);
    expect(inBounds(0, BOARD_SIZE)).toBe(false);
  });
});

describe('applyMove validation', () => {
  let board: Board;
  beforeEach(() => {
    board = createBoard();
  });

  it('rejects out-of-bounds moves', () => {
    const r = applyMove(board, -1, 0, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bounds/i);
  });

  it('rejects taken cells', () => {
    expect(applyMove(board, 7, 7, 1).ok).toBe(true);
    const r = applyMove(board, 7, 7, 2);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/taken/i);
  });

  it('accepts a normal move and mutates the board', () => {
    const r = applyMove(board, 3, 4, 1);
    expect(r.ok).toBe(true);
    expect(r.win).toBeFalsy();
    expect(board[idx(3, 4)]).toBe(1);
  });
});

describe('win detection', () => {
  it('detects a horizontal 5-in-a-row', () => {
    const board = createBoard();
    for (let c = 0; c < WIN_COUNT - 1; c++) applyMove(board, 5, c, 1);
    const r = applyMove(board, 5, 4, 1);
    expect(r.ok).toBe(true);
    expect(r.win).toBe(true);
    expect(r.winningLine).toHaveLength(WIN_COUNT);
  });

  it('detects a vertical win', () => {
    const board = createBoard();
    for (let row = 0; row < WIN_COUNT - 1; row++) applyMove(board, row, 2, 2);
    const r = applyMove(board, 4, 2, 2);
    expect(r.win).toBe(true);
  });

  it('detects a diagonal down-right win', () => {
    const board = createBoard();
    for (let s = 0; s < WIN_COUNT - 1; s++) applyMove(board, s, s, 1);
    const r = applyMove(board, 4, 4, 1);
    expect(r.win).toBe(true);
  });

  it('detects a diagonal down-left win', () => {
    const board = createBoard();
    for (let s = 0; s < WIN_COUNT - 1; s++) applyMove(board, s, 10 - s, 1);
    const r = applyMove(board, 4, 6, 1);
    expect(r.win).toBe(true);
  });

  it('does not falsely report a win for 4-in-a-row', () => {
    const board = createBoard();
    for (let c = 0; c < WIN_COUNT - 1; c++) {
      const r = applyMove(board, 8, c, 1);
      expect(r.win).toBeFalsy();
    }
    expect(findWinningLine(board, 8, WIN_COUNT - 2, 1)).toBeNull();
  });

  it('does not connect across two different marks', () => {
    const board = createBoard();
    applyMove(board, 0, 0, 1);
    applyMove(board, 0, 1, 1);
    applyMove(board, 0, 2, 2); // opponent interrupts
    applyMove(board, 0, 3, 1);
    const r = applyMove(board, 0, 4, 1);
    expect(r.win).toBeFalsy();
  });
});

describe('draw detection', () => {
  it('reports a draw when the board fills with no winner', () => {
    // Pattern (r + 2c) mod 5 -> two marks. Along every direction the residue
    // advances by a nonzero step coprime to 5, so any 5 consecutive cells hit
    // all 5 residues -> both marks present -> never 5-in-a-row anywhere.
    const markAt = (r: number, c: number): 1 | 2 =>
      ((r + 2 * c) % 5 < 3 ? 1 : 2) as 1 | 2;
    const board = createBoard();
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (r === BOARD_SIZE - 1 && c === BOARD_SIZE - 1) continue; // leave last
        board[idx(r, c)] = markAt(r, c);
      }
    }
    const r = applyMove(
      board,
      BOARD_SIZE - 1,
      BOARD_SIZE - 1,
      markAt(BOARD_SIZE - 1, BOARD_SIZE - 1),
    );
    expect(r.ok).toBe(true);
    expect(r.win).toBeFalsy();
    expect(r.draw).toBe(true);
  });
});
