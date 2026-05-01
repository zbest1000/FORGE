// Image transcode pipeline for asset visuals.
//
// Phase 7e of the Asset Dashboard work. The dashboard accepts user-uploaded
// asset visuals as PNG / JPEG / WebP / BMP directly, but modern phones
// produce HEIC and AVIF natively, and those formats don't render in every
// browser. Rather than ship a frontend HEIC decoder we transcode at upload
// time: a single WebP becomes the primary asset visual, with a JPEG
// derivative kept for downstream tooling that doesn't speak WebP yet.
//
// The pipeline is deliberately conservative:
//
// * Inputs are size-capped at 25 MB. Asset visuals on industrial dashboards
//   are thumbnails, not photographs — anything larger is almost certainly
//   either an over-sized smartphone burst or someone trying to wedge a PDF
//   through the upload route.
// * We honor EXIF orientation (`.rotate()`) so a portrait shot from a phone
//   doesn't render sideways.
// * We resize-to-fit a 2048 x 2048 box without enlarging smaller inputs.
//   This bounds the on-disk cost without softening sharp diagrams.
// * We use mozjpeg quantization for the JPEG fallback to shave bytes
//   without a perceptible quality drop.
//
// Errors thrown by this module carry a `.code` field (`FORGE_TRANSCODE_*`)
// so the upload route can map them onto HTTP responses (413 / 415 / 500)
// without re-parsing the message string.

import sharp from "sharp";

// Hard upper bound on the input buffer. Mirrors the 25 MB ceiling the
// upload route advertises. The check is also enforced by the route prior
// to calling this helper, but we re-assert here so anyone calling the
// service directly (e.g. tests, future batch tooling) still gets the
// guard rail.
export const MAX_TRANSCODE_INPUT_BYTES = 25 * 1024 * 1024;

// Output box. Asset cards on the dashboard render at most ~640 px wide on
// retina displays; 2048 leaves headroom for the asset detail screen and
// future zoom UIs without bloating storage.
const OUTPUT_MAX_DIMENSION = 2048;

// Encoder knobs. WebP is the canonical output (smallest at equivalent
// quality, supported by every modern browser); JPEG is the lowest-common-
// denominator fallback for legacy tools.
const WEBP_QUALITY = 85;
const WEBP_EFFORT = 4;
const JPEG_QUALITY = 88;

// MIMEs that this pipeline will accept as input. HEIC and HEIF share the
// same container (`ftyp` brand `heic`/`heix`/`mif1`/`msf1`); AVIF rides on
// the same ISO Base Media File Format with brand `avif`. The route's
// magic-byte sniffer normalises to one of these strings before calling.
const TRANSCODABLE_MIMES = new Set([
  "image/heic",
  "image/heif",
  "image/avif",
]);

/** True when the supplied MIME is one this module knows how to transcode. */
export function isTranscodable(mime) {
  if (!mime) return false;
  return TRANSCODABLE_MIMES.has(String(mime).toLowerCase());
}

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Transcode an asset visual buffer into a WebP primary plus a JPEG
 * derivative. Both outputs are bounded by `OUTPUT_MAX_DIMENSION` and
 * EXIF-rotated.
 *
 * @param {Buffer} buffer - raw image bytes (HEIC / HEIF / AVIF).
 * @param {string} mimeIn - sniffed MIME (`image/heic`, `image/heif`, or `image/avif`).
 * @returns {Promise<{
 *   webp:   { buffer: Buffer, mime: "image/webp", size: number, width: number, height: number },
 *   jpeg:   { buffer: Buffer, mime: "image/jpeg", size: number, width: number, height: number },
 *   sourceMime: string,
 *   sourceSize: number,
 * }>}
 *
 * Throws an Error with `code`:
 *   - FORGE_TRANSCODE_TOO_LARGE     (input > 25 MB)
 *   - FORGE_TRANSCODE_UNSUPPORTED   (MIME outside the allowlist)
 *   - FORGE_TRANSCODE_INVALID       (sharp failed to decode)
 *   - FORGE_TRANSCODE_FAILED        (encoder fault)
 */
export async function transcodeAssetVisual(buffer, mimeIn) {
  if (!Buffer.isBuffer(buffer)) {
    throw makeError("FORGE_TRANSCODE_INVALID", "buffer required");
  }
  if (buffer.length === 0) {
    throw makeError("FORGE_TRANSCODE_INVALID", "buffer is empty");
  }
  if (buffer.length > MAX_TRANSCODE_INPUT_BYTES) {
    throw makeError(
      "FORGE_TRANSCODE_TOO_LARGE",
      `payload exceeds ${MAX_TRANSCODE_INPUT_BYTES} byte limit (got ${buffer.length} bytes)`,
    );
  }
  if (!isTranscodable(mimeIn)) {
    throw makeError(
      "FORGE_TRANSCODE_UNSUPPORTED",
      `unsupported MIME for transcode: ${mimeIn}`,
    );
  }

  // Sniff the container upfront. `metadata()` parses the file header
  // without fully decoding pixel data — fast, and gives us a clean
  // INVALID error path for garbage input rather than the muddier
  // FAILED path that surfaces only when the encoder hits the bad
  // bytes. It also lets us reject zero-pixel inputs (a 12-byte ftyp
  // header with no payload would otherwise throw mid-encode).
  let metadata;
  try {
    metadata = await sharp(buffer, { failOn: "error" }).metadata();
  } catch (err) {
    throw makeError("FORGE_TRANSCODE_INVALID", `decode failed: ${err.message}`);
  }
  if (!metadata?.width || !metadata?.height) {
    throw makeError("FORGE_TRANSCODE_INVALID", "image has no decodable dimensions");
  }

  // Build a shared decode pipeline. Each output clones from this so
  // we only pay decode + rotate + resize once per request, not twice.
  const pipeline = sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({
      width: OUTPUT_MAX_DIMENSION,
      height: OUTPUT_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });

  let webpOut, jpegOut;
  try {
    webpOut = await pipeline
      .clone()
      .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw makeError("FORGE_TRANSCODE_FAILED", `webp encode failed: ${err.message}`);
  }
  try {
    jpegOut = await pipeline
      .clone()
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw makeError("FORGE_TRANSCODE_FAILED", `jpeg encode failed: ${err.message}`);
  }

  return {
    webp: {
      buffer: webpOut.data,
      mime: "image/webp",
      size: webpOut.info.size,
      width: webpOut.info.width,
      height: webpOut.info.height,
    },
    jpeg: {
      buffer: jpegOut.data,
      mime: "image/jpeg",
      size: jpegOut.info.size,
      width: jpegOut.info.width,
      height: jpegOut.info.height,
    },
    sourceMime: String(mimeIn).toLowerCase(),
    sourceSize: buffer.length,
  };
}

export default { transcodeAssetVisual, isTranscodable, MAX_TRANSCODE_INPUT_BYTES };
