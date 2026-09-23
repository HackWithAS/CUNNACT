// Cloudinary image uploads (unsigned) and delivery helpers.
//
// SECURITY: only the cloud name and the UNSIGNED upload preset live here — both are
// meant to be public. The Cloudinary API Secret must never appear in this project.
// One consequence: the browser alone can't delete images from Cloudinary (see README).

export const CLOUDINARY = Object.freeze({
  cloudName: "qfw2dy0h",
  uploadPreset: "cunnact_uploads",
  uploadUrl: "https://api.cloudinary.com/v1_1/qfw2dy0h/image/upload",
  autoUploadUrl: "https://api.cloudinary.com/v1_1/qfw2dy0h/auto/upload",
  maxBytes: 5 * 1024 * 1024,
  allowedTypes: Object.freeze(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  timeoutMs: 60000
});

export const MESSAGES = Object.freeze({
  none: "Please select an image.",
  invalid: "Please select a valid image.",
  tooLarge: "Image must be smaller than 5 MB.",
  failed: "Couldn't upload image. Please try again.",
  offline: "You're offline. Check your connection and try again."
});

/** Error whose `userMessage` is always safe to show — raw Cloudinary/network errors never reach the UI. */
export class UploadError extends Error {
  constructor(kind, userMessage) {
    super(kind);
    this.name = "UploadError";
    this.kind = kind; // none | type | size | network | timeout | http | response | aborted
    this.userMessage = userMessage;
  }
}

/* ---------------- Validation ---------------- */

async function sniffImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Throws UploadError unless `file` is a real JPEG/PNG/WebP/GIF under the size limit.
 * Checks the declared MIME type AND the file's magic bytes, so a relabeled file is rejected.
 */
export async function validateImageFile(file) {
  if (!file) throw new UploadError("none", MESSAGES.none);
  if (!file.size) throw new UploadError("type", MESSAGES.invalid);
  const declared = (file.type || "").toLowerCase();
  if (declared && !CLOUDINARY.allowedTypes.includes(declared)) throw new UploadError("type", MESSAGES.invalid);
  const sniffed = await sniffImageType(file).catch(() => null);
  if (!sniffed) throw new UploadError("type", MESSAGES.invalid);
  if (file.size >= CLOUDINARY.maxBytes) throw new UploadError("size", MESSAGES.tooLarge);
  return sniffed;
}

/* ---------------- URL safety ---------------- */

/** True only for an https URL on OUR Cloudinary cloud. Every image URL read from Firestore passes through this. */
export function isTrustedImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "res.cloudinary.com" &&
      u.pathname.startsWith(`/${CLOUDINARY.cloudName}/`);
  } catch { return false; }
}

/* ---------------- Upload ---------------- */

/**
 * Uploads an image to Cloudinary with the unsigned preset and resolves with its `secure_url`.
 * opts.onProgress(0..1) reports real upload progress; opts.signal (AbortSignal) cancels it.
 */
export async function uploadImageToCloudinary(file, { onProgress, signal } = {}) {
  await validateImageFile(file);
  if (signal?.aborted) throw new UploadError("aborted", "");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new UploadError("network", MESSAGES.offline);
  }

  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY.uploadPreset);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fail = (kind, detail) => {
      if (detail) console.warn("[cloudinary]", kind, detail); // logged for devs, never shown to users
      reject(new UploadError(kind, kind === "aborted" ? "" : MESSAGES.failed));
    };
    xhr.open("POST", CLOUDINARY.uploadUrl);
    xhr.timeout = CLOUDINARY.timeoutMs;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* handled below */ }
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok && body && isTrustedImageUrl(body.secure_url)) {
        onProgress?.(1);
        resolve(body.secure_url);
      } else {
        fail(ok ? "response" : "http", `HTTP ${xhr.status}`);
      }
    };
    xhr.onerror = () => fail("network", "network error");
    xhr.ontimeout = () => fail("timeout", "timeout");
    xhr.onabort = () => fail("aborted");
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export async function uploadFileToCloudinary(file, { onProgress, signal } = {}) {
  if (!file) throw new UploadError("none", "Please select a file.");
  if (!file.size) throw new UploadError("type", "The selected file is empty.");
  if (file.size > 25 * 1024 * 1024) throw new UploadError("size", "File must be smaller than 25 MB.");
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new UploadError("network", MESSAGES.offline);
  if (signal?.aborted) throw new UploadError("aborted", "");
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", CLOUDINARY.uploadPreset);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fail = (kind, detail) => { if (detail) console.warn("[cloudinary]", kind, detail); reject(new UploadError(kind, kind === "size" ? "File is too large." : kind === "aborted" ? "" : "Couldn't upload the file. Please try again.")); };
    xhr.open("POST", CLOUDINARY.autoUploadUrl);
    xhr.timeout = CLOUDINARY.timeoutMs;
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null; try { body = JSON.parse(xhr.responseText); } catch {}
      const ok = xhr.status >= 200 && xhr.status < 300;
      const url = body?.secure_url;
      if (ok && isTrustedCloudinaryUrl(url)) { onProgress?.(1); resolve(url); } else fail(ok ? "response" : "http", `HTTP ${xhr.status}`);
    };
    xhr.onerror = () => fail("network", "network error");
    xhr.ontimeout = () => fail("timeout", "timeout");
    xhr.onabort = () => fail("aborted");
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export function isTrustedCloudinaryUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "res.cloudinary.com" && u.pathname.startsWith(`/${CLOUDINARY.cloudName}/`); } catch { return false; }
}

/* ---------------- Delivery (smaller images instead of full-resolution originals) ---------------- */

const AUTO = "f_auto,q_auto";
export const PRESETS = Object.freeze({
  avatarSm: `c_fill,g_face,w_96,h_96,${AUTO}`,    // sidebar rows / chat header, shown ~46px (2x)
  avatarXl: `c_fill,g_face,w_288,h_288,${AUTO}`,  // profile page, shown ~128-144px (2x)
  chat: `c_limit,w_720,${AUTO}`,                  // chat bubbles, shown up to ~320px wide (2x)
  full: `c_limit,w_1800,${AUTO}`                  // lightbox
});

/** Inserts a delivery transformation into a Cloudinary URL. Returns the input unchanged if it isn't ours. */
export function imageUrl(url, preset) {
  if (!isTrustedImageUrl(url)) return url;
  const t = PRESETS[preset] || preset;
  return url.replace("/image/upload/", `/image/upload/${t}/`);
}

/**
 * Sets img.src to the optimised URL and falls back to the original if the transformed one
 * fails to load (e.g. "Strict transformations" is on). hooks.onFail runs only if the
 * original also fails, e.g. the image was deleted from Cloudinary.
 */
export function loadCloudinaryImage(img, url, preset, hooks = {}) {
  const sources = [...new Set([imageUrl(url, preset), url])];
  let i = 0;
  const tryNext = () => {
    if (i >= sources.length) { hooks.onFail?.(); return; }
    img.src = sources[i++];
  };
  img.addEventListener("load", () => hooks.onLoad?.(), { once: false });
  img.addEventListener("error", tryNext);
  tryNext();
}
