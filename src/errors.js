/** An error that is sent to the client as  { error: message, ...extra }  with this HTTP status. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
/** Throws an HttpError (usable in expressions: `x || fail(422, '...')`). */
export function fail(status, message, extra) {
  throw new HttpError(status, message, extra);
}
