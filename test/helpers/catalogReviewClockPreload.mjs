import { CATALOG_REVIEW_CLOCK } from "./catalogReviewInstant.mjs";
if (process.env.NODE_ENV !== "test") throw new Error("catalog clock is test-only");
const RealDate = globalThis.Date;
const instant = RealDate.parse(CATALOG_REVIEW_CLOCK);
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
