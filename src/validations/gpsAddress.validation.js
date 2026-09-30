import Joi from "joi";
import { isValidDigitalAddress, normaliseDigitalAddress } from "../utils/ghanaPostGps.js";

/**
 * The one definition of a valid Ghana Post GPS address as a Joi rule.
 *
 * Two endpoints write `School.gpsAddress` — `PUT /schools/:schoolId` (Step 1) and
 * `PUT /settings/:schoolId` — and they must not disagree. If one is strict and
 * the other is not, the looser one silently becomes the way a typo reaches the
 * database, and the value ends up on a receipt either way.
 *
 * Stored canonically as `GA-183-8164`. The undashed spelling is accepted on input
 * because Ghana Post's own API emits it and older rows predate the picker, but
 * nothing downstream should ever have to handle two forms.
 */
export const gpsAddressValidator = Joi.string()
  .trim()
  .max(200)
  .allow("")
  .custom((value, helpers) => {
    // Empty stays valid. The field is optional, and an absent address is honest
    // where a guessed one is not.
    if (value === "") return value;
    if (!isValidDigitalAddress(value)) {
      return helpers.error("any.invalid");
    }
    return normaliseDigitalAddress(value);
  })
  .messages({
    "any.invalid":
      "Enter a valid Ghana Post GPS address, e.g. GA-183-8164 (2 letters, then 3 digits, then 4 digits)",
  });

export default gpsAddressValidator;
