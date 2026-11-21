'use strict';

const { z } = require('zod');

/** Positive integer id taken from a URL segment. */
const id = z.coerce.number().int().positive();

const idParam = z.object({ id });

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A date (`2026-12-31`) or ISO-8601 datetime (`2026-12-31T17:00:00Z`).
 * Normalised to a full UTC ISO string so values sort and compare consistently.
 */
const isoDate = z
  .string()
  .trim()
  .refine((s) => {
    if (!ISO_PATTERN.test(s)) return false;
    const date = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
    if (Number.isNaN(date.getTime())) return false;
    // Reject overflowing dates such as 2026-02-31 that JS would silently roll over.
    return s.length !== 10 || date.toISOString().startsWith(s);
  }, 'Must be an ISO 8601 date (YYYY-MM-DD) or datetime')
  .transform((s) => new Date(s.length === 10 ? `${s}T00:00:00Z` : s).toISOString());

module.exports = { id, idParam, isoDate };
