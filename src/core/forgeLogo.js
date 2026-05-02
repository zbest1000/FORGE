// FORGE brand mark.
//
// A bold "F" monogram on a dark rounded backplate, in the app's sky-blue
// accent. The bottom of the stem widens into an anvil-shaped foot
// (industrial reference, instantly readable). A warm amber spark sits
// at the top-right of the top bar — the moment a hammer strikes hot
// metal. That's the "forge".
//
// Geometry tuned to read at 40×40 (the rail) — stems and bars are
// chunky, the anvil foot is unambiguously wider than the stem, and
// the spark is large enough to register as a separate element rather
// than a JPEG artefact.
//
// Single source of truth — the favicon (`icon.svg`) is generated from
// the same geometry, so the brand mark you see in the rail / hub
// matches the browser tab. Keep them in lockstep when iterating.
//
// IDs are scoped per call so multiple instances on a page (rail + hub
// on the same screen) don't collide — `<linearGradient id>` references
// via `url(#…)` are document-global.

import { el } from "./ui.js";

let _seq = 0;

/**
 * Build the SVG markup for the mark with per-call unique gradient IDs.
 * @returns {string}
 */
function markSvg() {
  const id = ++_seq;
  const fg = `forge-fg-${id}`;
  const fs = `forge-fs-${id}`;
  const sp = `forge-sp-${id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="FORGE">
  <title>FORGE</title>
  <defs>
    <linearGradient id="${fg}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7dd3fc"/>
      <stop offset="50%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="${fs}" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#0c4a6e"/>
    </linearGradient>
    <radialGradient id="${sp}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fef9c3" stop-opacity="1"/>
      <stop offset="45%" stop-color="#fde047" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- Dark rounded backplate -->
  <rect width="64" height="64" rx="13" fill="#0b1220"/>
  <!-- Bold F monogram with anvil-shaped foot -->
  <path d="M 12 12 L 52 12 L 52 23 L 25 23 L 25 28 L 42 28 L 42 36 L 25 36 L 25 50 L 30 50 L 30 56 L 6 56 L 6 50 L 12 50 Z" fill="url(#${fg})"/>
  <!-- Anvil foot drop-shadow: tapered slab beneath the anvil giving
       the silhouette dimensional weight at every render size. -->
  <path d="M 6 56 L 30 56 L 28 60 L 8 60 Z" fill="url(#${fs})"/>
  <!-- Forged-steel highlight stripe along the top inside edge of the F.
       Subtle but reads as "this is metal, not flat color" at 64px. -->
  <path d="M 14 14 L 50 14 L 50 16 L 14 16 Z" fill="#bae6fd" opacity="0.55"/>
  <!-- Hammer-strike spark at the top-right corner of the top bar. -->
  <g transform="translate(54 14)">
    <circle r="8" fill="url(#${sp})"/>
    <path d="M 0 -5.5 L 0 5.5 M -5.5 0 L 5.5 0" stroke="#fef9c3" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M -3.5 -3.5 L 3.5 3.5 M -3.5 3.5 L 3.5 -3.5" stroke="#fde047" stroke-width="1" stroke-linecap="round" opacity="0.9"/>
  </g>
</svg>`;
}

/**
 * Return a fresh DOM element containing the FORGE brand mark.
 *
 * The element is a `<span class="forge-mark">` wrapping the inline SVG
 * — the wrapper exists so CSS can size the mark from the outside without
 * having to target the SVG directly (avoids `:has()` cross-browser
 * footguns).
 *
 * @returns {HTMLElement}
 */
export function forgeMark() {
  return el("span", { class: "forge-mark", "aria-hidden": "true", html: markSvg() });
}

/**
 * Return a horizontal lockup of the brand mark and the FORGE wordmark,
 * for surfaces that benefit from saying the name explicitly (sign-in
 * screens, marketing).
 *
 * @returns {HTMLElement}
 */
export function forgeWordmark() {
  return el("span", { class: "forge-wordmark", "aria-label": "FORGE" }, [
    forgeMark(),
    el("span", { class: "forge-wordmark-text", "aria-hidden": "true" }, ["FORGE"]),
  ]);
}
