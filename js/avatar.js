// One avatar system used everywhere: sidebar, chat header, search results, profile page.
// A user with a Cloudinary photoURL gets an optimised <img>; everyone else gets a
// colored initials circle. If the photo URL 404s (e.g. deleted on Cloudinary), we
// fall back to initials automatically instead of showing a broken image.

import { loadCloudinaryImage } from "./cloudinary.js";

const TINTS = ["#5b57e6", "#0f9d8f", "#e0563f", "#c9862a", "#3f6fd1"];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsFor(nameOrEmail) {
  const value = (nameOrEmail || "").trim();
  if (!value) return "?";
  if (value.includes("@")) return value[0].toUpperCase();
  const parts = value.split(/\s+/).filter(Boolean);
  const initials = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
  return initials.toUpperCase();
}

export function tintFor(seed) {
  return TINTS[hash(seed || "?") % TINTS.length];
}

/**
 * Fills an `.avatar` element (expects an <img> and a `.avatar-fallback` span inside)
 * for the given user. Call again whenever photoURL/name changes.
 */
export function paintAvatar(container, { photoURL, name, email, preset = "avatarSm" }) {
  if (!container) return;
  const img = container.querySelector("img");
  const fallback = container.querySelector(".avatar-fallback");
  const label = name || email || "";
  if (fallback) {
    fallback.textContent = initialsFor(label);
    container.style.setProperty("--avatar-tint", tintFor(label || "?"));
  }

  const showFallback = () => { if (img) img.hidden = true; if (fallback) fallback.hidden = false; };
  const showImage = () => { if (img) img.hidden = false; if (fallback) fallback.hidden = true; };

  if (photoURL && img) {
    loadCloudinaryImage(img, photoURL, preset, { onLoad: showImage, onFail: showFallback });
  } else {
    showFallback();
  }
}

/** Builds the standard avatar markup as an HTML string, for list items rendered via innerHTML. */
export function avatarHtml({ name, email }, { size = "", dot = true } = {}) {
  return `<span class="avatar ${size}"><img alt="" hidden><span class="avatar-fallback">${initialsFor(name || email)}</span>${dot ? '<span class="status-dot"></span>' : ""}</span>`;
}
