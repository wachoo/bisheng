import { getCompanyBoardUrl, visibleCompanyBoards } from './companyBoardLinks';

jest.mock('./platformAdminUrl', () => ({
  getPlatformAdminPanelUrl: () => 'http://127.0.0.1:3001/admin',
}));

it('links an ordinary monitor-only account to the platform origin', () => {
  expect(visibleCompanyBoards(['workstation', 'company_monitorboard'], false)).toEqual(['monitorboard']);
  expect(getCompanyBoardUrl('monitorboard')).toBe('http://127.0.0.1:3001/monitorboard');
});

it('shows each granted board independently and respects menu visibility', () => {
  expect(visibleCompanyBoards(['company_leadboard', 'company_monitorboard'], false, {monitorboard: false})).toEqual(['leadboard']);
  expect(visibleCompanyBoards(['admin'], false)).toEqual([]);
  expect(visibleCompanyBoards(null, false)).toEqual([]);
});

it('keeps company board links out of the desktop host', () => {
  expect(visibleCompanyBoards(['company_leadboard', 'company_monitorboard'], true)).toEqual([]);
});
