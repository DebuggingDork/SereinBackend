export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type Result<T> = { data: T; error: { message: string } | null };

// Unwraps a Supabase response that is expected to hold data.
export function must<T>(result: Result<T>): NonNullable<T> {
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.data as NonNullable<T>;
}

// Unwraps a Supabase response where finding nothing is a normal outcome.
export function maybe<T>(result: Result<T>): T {
  if (result.error) {
    throw new Error(result.error.message);
  }
  return result.data;
}
