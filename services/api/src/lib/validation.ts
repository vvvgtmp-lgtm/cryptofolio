import { Decimal } from 'decimal.js';
import { z } from 'zod';

/** Parse or throw ZodError (the error handler turns it into HTTP 400). */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export const uuidParam = z.object({ id: z.string().uuid() });

/** Accepts "0.5" or 0.5, returns a plain decimal string that fits numeric(38,18): max 20 integer + 18 fraction digits. */
export const decimalString = (opts: { allowZero?: boolean } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine(
      (v) => /^\d{1,20}(\.\d{1,18})?$/.test(v) && (opts.allowZero || new Decimal(v).greaterThan(0)),
      { message: opts.allowZero ? 'must be a non-negative decimal' : 'must be a positive decimal' },
    );
