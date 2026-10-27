// Mirrors private.has_long_number in the database and lib/guards.ts on the frontend.
// Serein never stores card or account numbers: twelve or more digits in a row, with at
// most one separator between them, is treated as one. Dates and times are removed first.
const DATES_AND_TIMES =
  /(?<![0-9])((19|20)[0-9]{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])|(0?[1-9]|[12][0-9]|3[01])[-/.](0?[1-9]|1[0-2])[-/.](19|20)[0-9]{2}|[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)(?![0-9])/g;
const LONG_NUMBER = /([0-9][^0-9a-zA-Z]?){12,}/;

export function hasLongNumber(value: string): boolean {
  return LONG_NUMBER.test(value.replace(DATES_AND_TIMES, ' '));
}
