import crypto from "node:crypto";
import { PAY_LINK_BASE_URL } from "../config/env.js";

// 8-char uppercase hex token (business rule #2): e.g. STU-8F3K9D2L
export const generatePayLinkToken = () =>
  `STU-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

export const buildPayLink = (token) => `${PAY_LINK_BASE_URL}/pay/${token}`;
