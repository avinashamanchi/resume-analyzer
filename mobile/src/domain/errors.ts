export type StableErrorCategory =
  | 'cancelled'
  | 'timeout'
  | 'validation'
  | 'network'
  | 'service'
  | 'invalid_response';

export type StableErrorDetails = Readonly<{
  code?: string;
  requestId?: string;
  retryable?: boolean;
}>;

const MESSAGES: Readonly<Record<StableErrorCategory, string>> = Object.freeze({
  cancelled: 'The request was cancelled.',
  timeout: 'The request timed out.',
  validation: 'The selected material is not supported.',
  network: 'The service could not be reached.',
  service: 'The service could not complete the request.',
  invalid_response: 'The service returned an invalid response.',
});

export class ResumeApiError extends Error {
  readonly category: StableErrorCategory;
  readonly code?: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(category: StableErrorCategory, details: StableErrorDetails = {}) {
    super(MESSAGES[category]);
    this.name = 'ResumeApiError';
    this.category = category;
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryable = details.retryable === true;
  }
}
