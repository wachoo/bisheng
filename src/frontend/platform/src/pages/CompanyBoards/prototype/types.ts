import type { SupplementalRow } from "@/controllers/API/companyRegisters";
import type {
  BoardAccess,
  BoardOverview,
  CompanyBoard,
} from "@/controllers/API/companyBoards";

export interface PrototypeViewProps {
  board: CompanyBoard;
  data: BoardOverview;
  registers: SupplementalRow[];
  access: BoardAccess;
  period: string;
  changePeriod: (period: string) => void;
  open: (target: string, title: string) => void;
}

export interface PrototypeDetailProps extends PrototypeViewProps {
  target: string;
  title: string;
}
