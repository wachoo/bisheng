from bisheng.common.errcode.base import BaseErrorCode


class BoardLedgerInvalidError(BaseErrorCode):
    Code = 17101
    Msg = "Invalid board ledger entry"


class BoardLedgerConflictError(BaseErrorCode):
    Code = 17102
    Msg = "Board ledger entry already exists or has been changed; refresh and retry"
