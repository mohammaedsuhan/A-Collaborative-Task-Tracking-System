'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validate req.body / req.query / req.params against zod schemas.
 * Parsed (and coerced) values are exposed on `req.valid` because Express 5
 * makes `req.query` read-only.
 *
 *   router.post('/', validate({ body: schema }), handler)
 */
function validate(schemas) {
  return (req, _res, next) => {
    const valid = {};
    const problems = [];

    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (result.success) {
        valid[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          problems.push({
            in: part,
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          });
        }
      }
    }

    if (problems.length) return next(badRequest('Validation failed', problems));
    req.valid = valid;
    next();
  };
}

module.exports = { validate };
