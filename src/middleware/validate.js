import Joi from 'joi';

/**
 * Builds an express middleware that validates a request segment against a Joi schema.
 *
 * The validated value is written back so downstream handlers read sanitised,
 * converted data. In Express 5 `req.query` is an accessor with no setter, so a
 * plain assignment throws; it is redefined instead.
 */
const writeBack = (req, source, value) => {
  if (source === 'query') {
    Object.defineProperty(req, 'query', {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  req[source] = value;
};

export const validate =
  (schema, source = 'body') =>
  (req, res, next) => {
    // A Joi object schema treats `undefined` as a valid optional root, so a
    // request with no body at all would pass validation untouched and then crash
    // the handler the moment it destructured `req.body`. Express 5 leaves
    // `req.body` undefined when no body is sent, which a bare fetch or a
    // `curl -X DELETE` produces easily.
    //
    // The missing body is normalised to an empty object rather than rejected:
    // the schema is the authority on whether a field is required, so a bodyless
    // DELETE whose body schema is entirely optional (cancelling a payment plan,
    // for example) still succeeds, while one that requires a field reports that
    // field as missing with a 422 instead of crashing with a 500.
    const input =
      source === 'body' && (req[source] === undefined || req[source] === null) ? {} : req[source];

    const { error, value } = schema.validate(input, {
      abortEarly: true,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      return res.status(422).json({
        success: false,
        message: error.details[0].message,
        errors: error.details.map((detail) => detail.message),
      });
    }

    writeBack(req, source, value);
    next();
  };

export default validate;
