/** An error whose message is safe and useful to show the user (everything else gets a generic message). */
export function userError(message, status = 422) {
  const err = new Error(message);
  err.expose = true;
  err.status = status;
  return err;
}
