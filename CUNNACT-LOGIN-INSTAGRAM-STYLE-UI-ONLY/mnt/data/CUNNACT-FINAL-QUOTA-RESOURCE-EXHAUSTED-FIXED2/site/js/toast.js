// Lightweight toast notifications. One live region, reused for every toast.

let container = null;
function getContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-stack";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

/** kind: "info" | "success" | "error" */
export function showToast(message, kind = "info", duration = 3200) {
  if (!message) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  getContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const remove = () => {
    el.classList.remove("show");
    el.addEventListener("transitionend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // safety net if transitionend doesn't fire
  };
  setTimeout(remove, duration);
  return remove;
}
