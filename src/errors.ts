/**
 * An error whose message is safe and useful to show to the model / end user verbatim.
 */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly code = 'user_error',
  ) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
