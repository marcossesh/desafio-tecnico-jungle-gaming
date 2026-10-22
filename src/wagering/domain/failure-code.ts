/** Valores são contrato público — não renomear. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientFundsForReversal = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ProcessingFailed = 'PROCESSING_FAILED',
}
