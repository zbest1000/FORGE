// Time formatting helper. Uses date-fns when available, falls back to
// Intl.RelativeTimeFormat / toLocaleString otherwise.

import { vendor } from "./vendor.js";

let _df = null;
(async () => { try { _df = await vendor.dateFns(); } catch { /* noop */ } })();

export function relative(ts) {
  if (!ts) return "—";
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return "—";
  if (_df && _df.formatDistanceToNowStrict) {
    try { return _df.formatDistanceToNowStrict(ms, { addSuffix: true }); } catch {}
  }
  // Fallback.
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? " ago" : " from now";
  const min = 60_000, hour = 60 * min, day = 24 * hour;
  if (abs < hour) return Math.round(abs / min) + " min" + suffix;
  if (abs < day) return Math.round(abs / hour) + " h" + suffix;
  return Math.round(abs / day) + " d" + suffix;
}

export function absolute(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
