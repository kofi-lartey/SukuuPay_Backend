import { GHANA_SCHOOLS_API_URL, GHANA_SCHOOLS_API_KEY } from "../config/env.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const memoryCache = new Map();

function cacheKey(query) {
  return `school_search_${JSON.stringify(query)}`;
}

function isCacheValid(entry) {
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

async function fetchFromExternalApi(params) {
  if (!GHANA_SCHOOLS_API_URL || !GHANA_SCHOOLS_API_KEY) {
    return [];
  }

  const url = new URL(`${GHANA_SCHOOLS_API_URL}/search`);
  if (params.q) url.searchParams.set("q", params.q);
  if (params.region) url.searchParams.set("region", params.region);
  if (params.district) url.searchParams.set("district", params.district);
  if (params.limit) url.searchParams.set("limit", String(params.limit));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${GHANA_SCHOOLS_API_KEY}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    console.warn(`Ghana Schools API error: ${response.status} ${response.statusText}`);
    return [];
  }

  const data = await response.json();
  return normalizeExternalResults(data);
}

function normalizeExternalResults(raw) {
  if (!Array.isArray(raw)) {
    if (raw?.schools && Array.isArray(raw.schools)) return normalizeExternalResults(raw.schools);
    if (raw?.data && Array.isArray(raw.data)) return normalizeExternalResults(raw.data);
    return [];
  }

  return raw.map((school) => ({
    externalId: school.id || school._id || school.emisCode || school.code || "",
    name: school.name || school.schoolName || "",
    region: school.region || school.regionName || "",
    district: school.district || school.districtName || "",
    level: school.level || school.schoolLevel || school.category || "Basic/Primary",
    category: school.category || school.type || school.ownership || "Private",
    source: "ghana_api",
  })).filter((s) => s.name && s.externalId);
}

export async function searchSchoolsDirectory(params) {
  const key = cacheKey(params);
  const cached = memoryCache.get(key);
  if (cached && isCacheValid(cached)) {
    return cached.data;
  }

  try {
    const results = await fetchFromExternalApi(params);
    memoryCache.set(key, { data: results, timestamp: Date.now() });
    return results;
  } catch (error) {
    console.error("School directory search failed:", error.message);
    return [];
  }
}

export function clearSchoolDirectoryCache() {
  memoryCache.clear();
}

export function getSchoolDirectoryCacheStats() {
  return {
    size: memoryCache.size,
    keys: Array.from(memoryCache.keys()),
  };
}