// CUNNACT single-source avatar renderer.
// Exactly one of image/fallback is visible at any time.
const TINTS = ["#5b57e6", "#0f9d8f", "#e0563f", "#c9862a", "#3f6fd1"];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsFor(value) {
  const text = String(value || "").trim();
  if (!text) return "?";
  if (text.includes("@")) return text[0].toUpperCase();
  const parts = text.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : parts[0].slice(0, 2)).toUpperCase();
}

export function tintFor(seed) {
  return TINTS[hash(seed || "?") % TINTS.length];
}

function showOnly(container, kind) {
  const img = container.querySelector("img");
  const fallback = container.querySelector(".avatar-fallback");
  if (kind === "image") {
    if (fallback) fallback.hidden = true;
    if (img) { img.hidden = false; img.style.display = "block"; }
  } else {
    if (img) { img.hidden = true; img.style.display = "none"; img.removeAttribute("src"); }
    if (fallback) { fallback.hidden = false; fallback.style.display = "flex"; }
  }
}

export function paintAvatar(container, { photoURL = "", name = "", email = "", preset = "avatarSm" } = {}) {
  if (!container) return;
  const img = container.querySelector("img");
  const fallback = container.querySelector(".avatar-fallback");
  const label = name || email || "";
  const source = String(photoURL || "").trim();
  const token = String((Number(container.dataset.avatarToken || 0) + 1));
  container.dataset.avatarToken = token;
  container.style.setProperty("--avatar-tint", tintFor(label || "?"));

  if (fallback) {
    fallback.textContent = initialsFor(label);
    fallback.hidden = true;
    fallback.style.display = "none";
  }
  if (!img) {
    if (fallback) { fallback.hidden = false; fallback.style.display = "flex"; }
    return;
  }

  img.hidden = true;
  img.style.display = "none";
  img.removeAttribute("src");
  img.alt = label ? `${label} profile photo` : "Profile photo";

  if (!source) {
    showOnly(container, "fallback");
    return;
  }

  img.onload = () => {
    if (container.dataset.avatarToken !== token) return;
    showOnly(container, "image");
  };
  img.onerror = () => {
    if (container.dataset.avatarToken !== token) return;
    showOnly(container, "fallback");
  };
  // Direct assignment avoids stale handlers in helper abstractions.
  img.src = source;
}

export function avatarHtml({ name = "", email = "", photoURL = "" } = {}, { size = "", dot = false } = {}) {
  const fallback = initialsFor(name || email);
  return `<span class="avatar ${size}" data-avatar-photo="${photoURL ? "1" : "0"}"><img alt="" hidden><span class="avatar-fallback" hidden>${fallback}</span>${dot ? '<span class="status-dot"></span>' : ""}</span>`;
}
