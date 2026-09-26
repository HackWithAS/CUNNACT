// Fullscreen image preview. One overlay, reused for every image in the app.

import { imageUrl } from "./cloudinary.js";

let overlay, img, lastFocused;

function build() {
  overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close image preview">&times;</button>
    <img alt="Full size image">
  `;
  img = overlay.querySelector("img");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".lightbox-close").addEventListener("click", close);
  document.body.appendChild(overlay);
}

function onKeydown(e) {
  if (e.key === "Escape") close();
}

export function openLightbox(url) {
  if (!overlay) build();
  lastFocused = document.activeElement;
  img.src = imageUrl(url, "full");
  overlay.classList.add("open");
  document.body.classList.add("no-scroll");
  document.addEventListener("keydown", onKeydown);
  overlay.querySelector(".lightbox-close").focus();
}

export function close() {
  if (!overlay) return;
  overlay.classList.remove("open");
  document.body.classList.remove("no-scroll");
  document.removeEventListener("keydown", onKeydown);
  img.src = "";
  lastFocused?.focus?.();
}
