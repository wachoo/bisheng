import { Outlined } from 'bisheng-icons';
import { useAuthContext, useLocalize } from '~/hooks';
import { isDesktopEmbedded } from '~/components/Chat/desktopEmbedding';
import { getCompanyBoardUrl, visibleCompanyBoards } from '~/utils/companyBoardLinks';

export function CompanyBoardLinks() {
  const { user } = useAuthContext();
  const localize = useLocalize();
  const boards = visibleCompanyBoards(user?.plugins, isDesktopEmbedded(), window.APP_CONFIG?.companyBoardMenus);
  if (!boards.length) return null;
  return <nav className="flex shrink-0 flex-col gap-1" aria-label={localize('com_company_boards')}>
    {boards.map(board => <a key={board} href={getCompanyBoardUrl(board)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-body text-text-1 hover:bg-fill-1 focus-visible:bg-fill-1">
      <Outlined.Dashboard className="size-4 shrink-0" />
      <span>{localize(board === 'leadboard' ? 'com_company_leadboard' : 'com_company_monitorboard')}</span>
    </a>)}
  </nav>;
}
