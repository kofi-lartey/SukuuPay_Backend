import { Router } from 'express';
import { listPublicSchoolLogos, listPublicSchool } from '../controllers/public.controller.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * The unauthenticated, read-only school surface.
 *
 * Separate from `schoolAd.routes.js`'s `publicAdRoute` on purpose:
 * that router is the *advertisement* surface, and a school listing is
 * a different resource with a different projection to protect. Keeping
 * the two public routers in separate files means each one's security
 * boundary is readable in one place.
 *
 * Like the public ad route, every handler here is unauthenticated by
 * design and answers with a fixed projection — the homepage carousel
 * is the only consumer, and it needs a logo, a name and a colour.
 */
export const publicSchoolRoute = Router();

// The same budget the ad slider carries: 60 reads a minute is far more
// than a homepage's visitors generate, and tight enough to make a loop
// expensive.
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

publicSchoolRoute.get('/public/schools/logos', publicLimiter, listPublicSchoolLogos);

publicSchoolRoute.get('/public/schools/:schoolId', publicLimiter, listPublicSchool);

export default publicSchoolRoute;
