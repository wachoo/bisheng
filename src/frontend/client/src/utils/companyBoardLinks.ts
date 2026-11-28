import { getPlatformAdminPanelUrl } from './platformAdminUrl';

const boards = ['leadboard', 'monitorboard'] as const;
type Board = typeof boards[number];

export function visibleCompanyBoards(menus: readonly string[] | undefined | null, embedded: boolean, config?: Partial<Record<Board, boolean>>) {
  return embedded ? [] : boards.filter(board => menus?.includes('company_' + board) && config?.[board] !== false);
}

export function getCompanyBoardUrl(board: Board) {
  return new URL(board, getPlatformAdminPanelUrl()).href;
}
