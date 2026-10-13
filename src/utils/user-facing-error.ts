/**
 * An error whose message was written for the member who triggered it
 * ("Quote is too long…", "You do not have permission…").
 *
 * Command handlers relay only these to the member. Any other thrown error
 * (Mongoose `CastError`, driver or Discord API errors) can carry schema, query
 * or request detail, so handlers log it and reply with a generic message
 * instead (#1153).
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
