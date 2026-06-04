/**
 * Caro / Gomoku core rules (pure, no IO). 15x15 board, 5-in-a-row wins.
 * Server-authoritative: the gateway/service validate every move with these.
 */

export const BOARD_SIZE = 15;
export const WIN_COUNT = 5;

export type Cell = 0 | 1 | 2; // 0 empty, 1 = player X (first), 2 = player O
export type Board = Cell[]; // flat array length BOARD_SIZE*BOARD_SIZE

export function createBoard(): Board {
  return new Array(BOARD_SIZE * BOARD_SIZE).fill(0) as Board;
}

export function idx(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

export interface MoveResult {
  ok: boolean;
  error?: string;
  win?: boolean;
  draw?: boolean;
  winningLine?: number[]; // flat indices of the 5+ winning cells
}

/**
 * Applies a move for `mark` (1|2) at (row,col) on `board` (mutates board on
 * success). Returns whether it won / drew.
 */
export function applyMove(
  board: Board,
  row: number,
  col: number,
  mark: Cell,
): MoveResult {
  if (!inBounds(row, col)) return { ok: false, error: 'Out of bounds' };
  const i = idx(row, col);
  if (board[i] !== 0) return { ok: false, error: 'Cell already taken' };
  board[i] = mark;

  const line = findWinningLine(board, row, col, mark);
  if (line) return { ok: true, win: true, winningLine: line };
  if (board.every((c) => c !== 0)) return { ok: true, draw: true };
  return { ok: true };
}

/**
 * Checks the 4 directions through (row,col) for a run of >= WIN_COUNT of
 * `mark`. Returns the flat indices of the winning run, or null.
 */
export function findWinningLine(
  board: Board,
  row: number,
  col: number,
  mark: Cell,
): number[] | null {
  const dirs = [
    [0, 1], // horizontal
    [1, 0], // vertical
    [1, 1], // diagonal down-right
    [1, -1], // diagonal down-left
  ];
  for (const [dr, dc] of dirs) {
    const cells: number[] = [idx(row, col)];
    // forward
    for (let s = 1; s < WIN_COUNT; s++) {
      const r = row + dr * s;
      const c = col + dc * s;
      if (inBounds(r, c) && board[idx(r, c)] === mark) cells.push(idx(r, c));
      else break;
    }
    // backward
    for (let s = 1; s < WIN_COUNT; s++) {
      const r = row - dr * s;
      const c = col - dc * s;
      if (inBounds(r, c) && board[idx(r, c)] === mark)
        cells.unshift(idx(r, c));
      else break;
    }
    if (cells.length >= WIN_COUNT) return cells;
  }
  return null;
}
