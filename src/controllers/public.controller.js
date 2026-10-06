import { School } from '../models/schoolModel.js';

/**
 * The public school surface — unauthenticated, read-only, and
 * deliberately tiny.
 *
 * Everything here answers the marketing pages (the homepage logo
 * carousel), so the contract is the same one `listPublicSchoolAds`
 * holds: a fixed projection, a bounded result, and a response that
 * degrades to an empty list rather than an error. A broken carousel
 * must never break the homepage.
 */

/**
 * GET /public/schools/logos
 *
 * The logos of the schools on the platform, for the homepage carousel.
 *
 * **The projection is the security control.** `School` carries
 * `payment.bankAccount`, gateway credentials and the whole settlement
 * configuration (`schoolModel.js` `payment` subdocument). An
 * unauthenticated list must never `lean()` without naming its fields,
 * because a document without a projection is the entire school —
 * billing details included. So exactly three fields are named and
 * nothing else can appear in the response, the same discipline the
 * public ad endpoint applies to its projection.
 *
 * Only active, un-deleted schools with a logo are listed: a suspended
 * school is not a school to advertise, and a school without a logo
 * has nothing to show in a logo carousel.
 *
 * Caching follows the value: logos change when a school rebrands,
 * which is rare, so `max-age=300` is generous and the carousel is
 * cheap to serve.
 */
export const listPublicSchoolLogos = async (req, res) => {
  try {
    const schools = await School.find({
      status: 'active',
      deletedAt: null,
      logo: { $ne: null },
    })
      .select('name logo brandColor')
      .limit(24)
      .lean();

    res.set('Cache-Control', 'public, max-age=300');

    return res.status(200).json({
      success: true,
      schools: schools.map((school) => ({
        _id: school._id,
        name: school.name,
        logo: school.logo,
        brandColor: school.brandColor,
      })),
    });
  } catch (error) {
    // Never surface an error to the client: the homepage must degrade to
    // "no logos" rather than show a broken section.
    console.error('Public school logos fetch failed:', error.message);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, schools: [] });
  }
};

/**
 * GET /public/schools/:schoolId
 *
 * The public face of a school: enough for an advertisement detail card
 * and a WhatsApp contact button, and nothing sensitive. The projection
 * is the security control — `payment` and `sms` are deliberately absent.
 */
export const listPublicSchool = async (req, res) => {
  try {
    const { schoolId } = req.params;

    const school = await School.findOne({
      _id: schoolId,
      status: 'active',
      deletedAt: null,
    })
      .select('name logo brandColor address city region phone email website motto type yearFounded')
      .lean();

    if (!school) {
      return res.status(404).json({ success: false, message: 'School not found' });
    }

    res.set('Cache-Control', 'public, max-age=300');

    return res.status(200).json({
      success: true,
      school: {
        _id: school._id,
        name: school.name,
        logo: school.logo,
        brandColor: school.brandColor,
        address: school.address,
        city: school.city,
        region: school.region,
        phone: school.phone,
        email: school.email,
        website: school.website,
        motto: school.motto,
        type: school.type,
        yearFounded: school.yearFounded,
      },
    });
  } catch (error) {
    console.error('Public school fetch failed:', error.message);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: false, message: 'School not found' });
  }
};

export default { listPublicSchoolLogos, listPublicSchool };
