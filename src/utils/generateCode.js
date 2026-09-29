import { School } from "../models/schoolModel.js";

const GHANA_REGIONS = [
  "Ahafo",
  "Ashanti",
  "Bono",
  "Bono East",
  "Central",
  "Eastern",
  "Greater Accra",
  "North East",
  "Northern",
  "Oti",
  "Savannah",
  "Upper East",
  "Upper West",
  "Volta",
  "Western",
  "Western North",
];

export const generateSlug = (name) => {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

export const generateSchoolCode = async (name) => {
  const words = name.trim().split(/\s+/);
  let initials = "";

  if (words.length === 1) {
    initials = words[0].substring(0, 3).toUpperCase();
  } else if (words.length === 2) {
    initials = words[0].substring(0, 2).toUpperCase() + words[1].substring(0, 1).toUpperCase();
  } else {
    initials = words
      .slice(0, 3)
      .map((w) => w.substring(0, 1).toUpperCase())
      .join("");
  }

  initials = initials.replace(/[^A-Z]/g, "").substring(0, 3);
  if (initials.length < 3) {
    initials = initials.padEnd(3, "X");
  }

  let counter = 1;
  let schoolCode = `${initials}${counter.toString().padStart(3, "0")}`;

  while (await School.exists({ schoolCode })) {
    counter++;
    schoolCode = `${initials}${counter.toString().padStart(3, "0")}`;
    if (counter > 999) {
      initials = initials.substring(0, 2) + String.fromCharCode(65 + (counter % 26));
      counter = 1;
    }
  }

  return schoolCode;
};

export const generateUniqueSlug = async (name) => {
  let slug = generateSlug(name);
  let counter = 1;
  let uniqueSlug = slug;

  while (await School.exists({ slug: uniqueSlug })) {
    uniqueSlug = `${slug}-${counter}`;
    counter++;
  }

  return uniqueSlug;
};

export const validateGhanaPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, "");
  const ghanaPatterns = [
    /^233\d{9}$/,
    /^0\d{9}$/,
    /^\d{9}$/,
  ];

  for (const pattern of ghanaPatterns) {
    if (pattern.test(cleaned)) {
      if (cleaned.startsWith("233")) return cleaned;
      if (cleaned.startsWith("0")) return "233" + cleaned.substring(1);
      return "233" + cleaned;
    }
  }
  return null;
};

export const isValidGhanaRegion = (region) => {
  return GHANA_REGIONS.includes(region);
};

export const getGhanaRegions = () => [...GHANA_REGIONS];