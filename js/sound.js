// Sound system for CUNNACT using Web Audio API
// Generates short, soft UI tones without external audio files

const SOUND_ENABLED_KEY = "cunnact_sound_enabled";
let audioContext = null;
let soundEnabled = localStorage.getItem(SOUND_ENABLED_KEY) !== "false";

function getContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

function playTone(frequency, duration, volume = 0.1, type = "sine") {
  if (!soundEnabled) return;

  try {
    const ctx = getContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;

    gainNode.gain.setValueAtTime(volume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

// UI interaction sounds
export function playClick() {
  playTone(800, 0.04, 0.08, "sine");
}

export function playSend() {
  const ctx = getContext();
  if (!soundEnabled) return;
  try {
    const raw = localStorage.getItem("cunnact_notification_settings");
    if (raw) { const pref = JSON.parse(raw); if (pref && pref.outgoingSound === false) return; }
  } catch {}

  try {
    // Two-tone swoosh
    playTone(600, 0.08, 0.1, "sine");
    setTimeout(() => playTone(800, 0.06, 0.08, "sine"), 30);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

export function playReceive() {
  const ctx = getContext();
  if (!soundEnabled) return;

  try {
    // Soft notification chime
    playTone(660, 0.1, 0.09, "sine");
    setTimeout(() => playTone(880, 0.12, 0.08, "sine"), 50);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

export function playNotification() {
  const ctx = getContext();
  if (!soundEnabled) return;

  try {
    // Triple chime for notifications
    playTone(523, 0.08, 0.1, "sine");
    setTimeout(() => playTone(659, 0.08, 0.1, "sine"), 70);
    setTimeout(() => playTone(784, 0.12, 0.1, "sine"), 140);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

export function playSave() {
  playTone(880, 0.06, 0.08, "triangle");
}

export function playDelete() {
  const ctx = getContext();
  if (!soundEnabled) return;

  try {
    // Descending tone
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.1);

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

export function playSuccess() {
  const ctx = getContext();
  if (!soundEnabled) return;

  try {
    // Success chord
    playTone(523, 0.1, 0.08, "sine");
    setTimeout(() => playTone(659, 0.1, 0.08, "sine"), 40);
    setTimeout(() => playTone(784, 0.15, 0.09, "sine"), 80);
  } catch (e) {
    console.warn("Sound playback failed:", e);
  }
}

export function playError() {
  playTone(300, 0.15, 0.1, "square");
}

// Sound toggle
export function isSoundEnabled() {
  return soundEnabled;
}

export function setSoundEnabled(enabled) {
  soundEnabled = !!enabled;
  localStorage.setItem(SOUND_ENABLED_KEY, soundEnabled ? "true" : "false");
}

export function toggleSound() {
  setSoundEnabled(!soundEnabled);
  return soundEnabled;
}
