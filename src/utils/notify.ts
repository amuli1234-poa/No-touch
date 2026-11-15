/**
 * Optional desktop notifications and speech synthesis for confirmed signals.
 * Both are best-effort enhancements: unsupported or denied environments degrade
 * silently rather than interrupting the analysis workflow.
 */

import type { SignalFeedItem } from '../types/signals';

let voiceEnabled = false;

export function setVoiceEnabled(next: boolean): void {
  voiceEnabled = next;
}

export function isVoiceSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Requests notification permission from a user gesture. Called when the user
 * enables notifications in Settings so the prompt is contextual.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNotificationSupported()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** One-line spoken/desktop summary of a signal. */
export function describeSignal(item: SignalFeedItem): string {
  const dir = item.direction === 'RISE' ? 'rise' : 'fall';
  const source =
    item.source === 'CO-ANALYSIS'
      ? 'validated by both engines'
      : item.source === 'SCANNER'
        ? 'from the scanner'
        : item.source === 'TRENDLINE'
          ? 'from the trendline scanner'
          : 'from the chart analyser';
  return `${item.displayName} ${dir} setup ${source}. Quality ${item.confidence} out of 100.`;
}

export function speakSignal(item: SignalFeedItem): void {
  if (!voiceEnabled || !isVoiceSupported()) return;
  try {
    const utterance = new SpeechSynthesisUtterance(describeSignal(item));
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech is a non-essential enhancement.
  }
}

export function showSignalNotification(item: SignalFeedItem): void {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return;
  try {
    const title =
      item.source === 'CO-ANALYSIS'
        ? `Validated ${item.direction} · ${item.displayName}`
        : `${item.direction} setup · ${item.displayName}`;
    new Notification(title, {
      body: `${item.timeframe} · ${item.modelLabel ?? 'Setup'} · ${item.confidence}/100`,
      tag: `${item.symbol}-${item.timeframe}-${item.direction}`,
    });
  } catch {
    // Notification construction can throw on some platforms; ignore.
  }
}
