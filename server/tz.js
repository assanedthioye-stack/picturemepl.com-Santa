// Wall-clock offsets from UTC. Senegal and Côte d'Ivoire are UTC+0, Benin is UTC+1 (none observe DST).
const OFFSET_H = { SN: 0, CI: 0, BJ: 1 };
const COUNTRIES = Object.keys(OFFSET_H);
const offsetMs = (country) => (OFFSET_H[country] || 0) * 3600000;
// ISO instant -> ISO-looking string whose fields read as the country's local wall time.
const local = (iso, country) => new Date(Date.parse(iso) + offsetMs(country)).toISOString();
const localDay = (iso, country) => local(iso, country).slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && !isNaN(Date.parse(s));
module.exports = { COUNTRIES, offsetMs, local, localDay, isDay };
