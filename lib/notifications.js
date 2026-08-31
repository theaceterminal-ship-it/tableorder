// Shared notification utility
const audioCtx = typeof window !== "undefined" ? new (window.AudioContext || window.webkitAudioContext)() : null;

export function playNotificationSound(type = "default") {
  if (!audioCtx) return;

  // Resume context if suspended (browser policy)
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  const oscillator = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  if (type === "newOrder") {
    // Ding-dong for new order
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(523, now); // C5
    oscillator.frequency.setValueAtTime(659, now + 0.15); // E5
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    oscillator.start(now);
    oscillator.stop(now + 0.5);
  } else if (type === "ready") {
    // Higher ding for ready
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now); // A5
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  } else if (type === "bill") {
    // Double beep for bill
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(440, now);
    oscillator.frequency.setValueAtTime(554, now + 0.1);
    gainNode.gain.setValueAtTime(0.3, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    oscillator.start(now);
    oscillator.stop(now + 0.3);
  } else {
    // Default soft ping
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(600, now);
    gainNode.gain.setValueAtTime(0.2, now);
    gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  }
}

// Request browser notification permission
export async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  const permission = await Notification.requestPermission();
  return permission === "granted";
}

// Show browser popup notification
export function showPopupNotification(title, body, options = {}) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  new Notification(title, {
    body,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: options.tag || "cabadra",
    renotify: options.renotify || false,
    requireInteraction: options.requireInteraction || false,
    ...options,
  });
}