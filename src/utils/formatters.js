// ─────────────────────────────────────────────
// Shared formatters
// ─────────────────────────────────────────────
// Money is stored as integer pesewas (1 GHS = 100 pesewas) everywhere in the
// platform, but is never shown to a person or a parent in that form.

// 55000 → "550.00"
export const toCedis = (pesewas) => (Math.round(Number(pesewas) || 0) / 100).toFixed(2);

// 55000 → "GHS 550.00"
export const formatCedis = (pesewas, currency = 'GHS') =>
  `${currency} ${toCedis(pesewas)}`;

// Date rendered in Accra (UTC+0, no daylight saving) in a human format.
export const formatAccraDate = (date) =>
  new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Accra',
  });

export const formatAccraDateTime = (date) =>
  new Date(date).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Accra',
  });
