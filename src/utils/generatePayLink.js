import crypto from "node:crypto";
import { PAY_LINK_BASE_URL } from "../config/env.js";

// 8-char uppercase hex token (business rule #2): e.g. STU-FCFEE2A4
//
// The alphabet is `[0-9A-F]` only, because that is what `toString("hex")` emits.
// The rule used to be documented here with `STU-8F3K9D2L` as the example, which is
// not a possible token — `K` and `L` are not hex digits — and
// `payTokenParamSchema` rejects it. That is a comment that makes a correct token
// look invalid and an impossible one look canonical; anyone writing a fixture from
// it gets a 422 from every `/pay/:token` route. The generator and the validator
// agree; only the example was wrong.
export const generatePayLinkToken = () =>
  `STU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

export const buildPayLink = (token) => `${PAY_LINK_BASE_URL}/pay/${token}`;
