"use client";

import { useEffect } from 'react';
import { redactTechnicalText } from '@/lib/dota-technical-core';

type BrowserIssue = { code: string; message: string; details: string; route: string };
const pending: BrowserIssue[] = [];
const recent = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let sentThisSession = 0;
const MAX_SESSION_EVENTS = 60;

function sameOriginFile(filename: string) {
  if (!filename || /(?:chrome|moz|safari)-extension:/.test(filename)) return false;
  try { const url = new URL(filename, window.location.origin); return url.origin === window.location.origin && /^https?:$/.test(url.protocol); }
  catch { return false; }
}

function ownStack(stack: string) {
  if (/(?:chrome|moz|safari)-extension:/.test(stack)) return false;
  return (stack.match(/https?:\/\/[^\s)]+/g) || []).some(sameOriginFile);
}

function scheduleFlush() {
  if (timer || inFlight || !pending.length) return;
  timer = setTimeout(() => { timer = undefined; void flush(); }, 1500);
}

async function flush() {
  if (inFlight || !pending.length || sentThisSession >= MAX_SESSION_EVENTS) return;
  const events = pending.splice(0, Math.min(10, MAX_SESSION_EVENTS - sentThisSession));
  sentThisSession += events.length;
  inFlight = true;
  try {
    // The collector must never become a source of recursive errors or retry storms.
    await fetch('/api/technical', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'capture', events }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* Best effort: the application keeps working if the journal is unavailable. */ }
  finally { inFlight = false; scheduleFlush(); }
}

function enqueue(code: string, message: string, details: string) {
  if (typeof window === 'undefined' || !message || sentThisSession >= MAX_SESSION_EVENTS || pending.length >= 10) return;
  const item = {
    code, message: redactTechnicalText(message, 1000), details: redactTechnicalText(details, 6000),
    route: redactTechnicalText(window.location.pathname, 300),
  };
  if (!item.message || /^script error\.?$/i.test(item.message)) return;
  const signature = item.code + '\n' + item.message + '\n' + item.details;
  const now = Date.now();
  if (now - (recent.get(signature) || 0) < 30000) return;
  recent.set(signature, now);
  if (recent.size > 60) recent.delete(recent.keys().next().value!);
  pending.push(item); scheduleFlush();
}

// Called only by our own React boundary, so the origin is already established.
export function captureRenderError(error: Error & { digest?: string }) {
  enqueue('browser.render', error.message || 'Ошибка отображения приложения.', error.stack || (error.digest ? 'Digest: ' + error.digest : ''));
}

export default function TechnicalErrorCapture() {
  useEffect(() => {
    function runtimeError(event: ErrorEvent) {
      if (!sameOriginFile(event.filename)) return;
      const details = event.error instanceof Error ? event.error.stack || '' : `${event.filename}:${event.lineno}:${event.colno}`;
      if (/(?:chrome|moz|safari)-extension:/.test(details)) return;
      enqueue('browser.runtime', event.message, details);
    }
    function rejected(event: PromiseRejectionEvent) {
      // Unattributed string rejections and external script failures are not project evidence.
      if (!(event.reason instanceof Error) || !ownStack(event.reason.stack || '')) return;
      enqueue('browser.unhandled_rejection', event.reason.message, event.reason.stack || '');
    }
    window.addEventListener('error', runtimeError);
    window.addEventListener('unhandledrejection', rejected);
    return () => {
      window.removeEventListener('error', runtimeError);
      window.removeEventListener('unhandledrejection', rejected);
    };
  }, []);
  return null;
}
