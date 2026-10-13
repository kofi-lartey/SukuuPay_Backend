/**
 * Geofence arithmetic for location-based attendance.
 *
 * A straight-line distance on a sphere is the right model here and a routing
 * distance is not: the question is "is this handset inside the school's
 * compound", the compound is a few hundred metres across, and the error between
 * a haversine and a road distance is a handful of metres. Paying for a directions
 * API to answer it would also mean the roll-call depends on a third party being up.
 *
 * Haversine rather than the equirectangular approximation, because the schools
 * using this are near the equator where the approximation is at its *best* and
 * it still drifts as the separation grows past a few hundred metres — the exact
 * case where a teacher standing at the gate and a student standing at the far
 * corner of the pitch must land on opposite sides of the line.
 */

const EARTH_RADIUS_M = 6371000;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Metres between two `{ lat, lng }` points. `Infinity` when either is missing. */
export const haversineMeters = (a, b) => {
  if (!a || !b) return Infinity;

  const aLat = Number(a.lat);
  const aLng = Number(a.lng);
  const bLat = Number(b.lat);
  const bLng = Number(b.lng);

  if ([aLat, aLng, bLat, bLng].some((v) => !Number.isFinite(v))) return Infinity;

  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * Whether a handset is within `meters` of the school, default 200m.
 *
 * The default is the compound gate, not the classroom: a school's block is a
 * building, and 200m from a point the school nominates as its centre covers the
 * yard, the assembly hall and the staff room without reaching across the road
 * into a neighbour's house.
 */
export const isWithinRadius = (studentLocation, schoolLocation, meters = 200) => {
  const radius = Number(meters);
  const limit = Number.isFinite(radius) && radius > 0 ? radius : 200;
  return haversineMeters(studentLocation, schoolLocation) <= limit;
};

export default { haversineMeters, isWithinRadius };
