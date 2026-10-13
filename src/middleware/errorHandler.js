/**
 * The rule `errorHandler` applies, as a reusable function.
 *
 * A 4xx message is written for the user: `ApiError('a schoolId is required…')` and
 * friends exist precisely to be read by a bursar or a parent. A 5xx message is not — it
 * is whatever the driver, the SDK or the service happened to throw, and it can carry
 * connection strings, query text and file paths. `status` is not a safe signal on its
 * own: Mongoose, body-parser and the MTN SDK all set `.status` on their own errors, so
 * trusting its mere presence handed a raw internal message to the client.
 *
 * Controllers that answer the request themselves cannot use the middleware, and each of
 * them was doing it independently — `payment.controller.js` had sixteen copies of
 * `message: error.message`, which is how `TypeError: next is not a function` was shown
 * verbatim to a parent on an **unauthenticated** pay link. Exporting the rule means a
 * controller that answers directly gets the same answer as one that falls through to the
 * middleware, and there is one place to change the policy.
 *
 * The full error, including the stack, is logged. That is the point: the detail stops
 * being a client-facing string and becomes a server-side record, which is where whoever
 * debugs it can actually read it.
 *
 * @param {any} error
 * @param {string} [fallback] what to say for a 5xx; should be written for the audience
 * @returns {string}
 */
export const resolveErrorMessage = (error, fallback = "Something went wrong. Please try again.") => {
  const status = error?.status || error?.statusCode || 500;
  const isClientError = status >= 400 && status < 500;

  if (isClientError) return error.message;
  console.error("Unhandled error:", error);
  return fallback;
};

const errorHandler = (error, _req, res, _next) => {
  // Duplicate key on a unique index (e.g. email already registered).
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      message: `An account with this ${field} already exists`,
      code: 'DUPLICATE_KEY',
      conflict: error.keyValue || null,
    });
  }

  if (error.name === 'ValidationError') {
    return res.status(422).json({
      success: false,
      message: error.message,
      errors: Object.values(error.errors || {}).map((item) => item.message),
    });
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  // Malformed request bodies. `express.json()` rejects unparseable input with an
  // `entity.parse.failed` SyntaxError, which is a client mistake, not a server
  // fault: it needs a 400 and a plain message, never a stack.
  //
  // Left unhandled this produced `400 {"stack": "SyntaxError: … at
  // /opt/render/project/src/node_modules/body-parser/…"}` for any anonymous
  // caller — full server filesystem paths, framework, and dependency tree.
  if (error.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return res.status(400).json({
      success: false,
      message: 'Request body is not valid JSON.',
    });
  }

  // Body larger than the express limit. Also a client error.
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request body is too large.',
    });
  }

// A 4xx message is written for the user: `ApiError('A schoolId is required…')`
  // and friends exist precisely to be read by a bursar. A 5xx message is not —
  // it is whatever the driver, the SDK, or the service happened to throw, and it
  // can carry connection strings, query text, and file paths.
  //
  // The previous check was `error.status ? error.message : 'Something went
  // wrong'`, which trusted the mere presence of a status. Mongoose, body-parser
  // and the MTN SDK all set `.status` on their own errors, so an internal
  // failure carrying `status: 500` handed its raw message to the client.
  //
  // That decision now lives in `resolveErrorMessage`, which is exported for the
  // controllers that answer the request themselves. There used to be sixteen
  // independent copies of the unsafe half of it in `payment.controller.js`, which is
  // how a `TypeError: next is not a function` was shown to a parent on an
  // unauthenticated pay link.
  const status = error.status || error.statusCode || 500;

  res.status(status).json({
    success: false,
    message: resolveErrorMessage(error),
    // The stack is a server-side diagnostic and must never reach a client. It
    // is not gated on NODE_ENV: a deployment left in development mode would
    // otherwise hand out absolute paths to every unauthenticated caller, and
    // NODE_ENV is exactly the variable that tends to be wrong in production.
    // The full error, including the stack, is logged above.
  });
};

export default errorHandler;
