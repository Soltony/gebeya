'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getWebApp, type TelegramWebApp } from './webapp';

export type TelegramMe = {
  firstName: string | null;
  phoneLinked: boolean;
  phoneMasked: string | null;
  canMessage: boolean;
  startPath: string;
};

export class TgApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

type TelegramContextValue = {
  webApp: TelegramWebApp | null;
  me: TelegramMe | null;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  refreshMe: () => Promise<TelegramMe>;
  /** Asks Telegram for the user's contact, then waits for the bot to link it. */
  linkPhone: () => Promise<boolean>;
  alert: (message: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  haptic: (type: 'error' | 'success' | 'warning') => void;
};

const TelegramContext = createContext<TelegramContextValue | null>(null);

export function useTelegram() {
  const ctx = useContext(TelegramContext);
  if (!ctx) throw new Error('useTelegram must be used inside TelegramProvider');
  return ctx;
}

const START_HANDLED_KEY = 'tg-start-param-handled';
const LAUNCH_INIT_DATA_KEY = 'tg-launch-init-data';
const LINK_POLL_ATTEMPTS = 15;
// Stop waiting for telegram-web-app.js after this; the app still works without it.
const SDK_WAIT_MS = 5000;
/**
 * Telegram's Mini App SDK, served from our own origin (public/) because
 * telegram.org is not reliably reachable from customers' networks. Refresh it
 * with: curl -o public/telegram-web-app.js https://telegram.org/js/telegram-web-app.js
 */
const SDK_SRC = '/telegram-web-app.js';
// Where telegram-web-app.js caches its launch parameters (see sessionStorageGet in the SDK).
const SDK_INIT_PARAMS_KEY = '__telegram__initParams';

/**
 * Telegram passes the signed launch data in the URL hash (#tgWebAppData=...).
 * Read it as soon as this module loads, so signing in does not depend on the
 * SDK script, and keep it for in-app reloads, which drop the hash. The full
 * hash is also seeded into the SDK's own cache: the SDK reads location.hash
 * when it runs, and by then client-side navigation may have replaced the URL.
 */
function captureLaunchInitData(): string {
  if (typeof window === 'undefined') return '';
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const fromHash = hashParams.get('tgWebAppData') || '';
  try {
    if (fromHash) {
      sessionStorage.setItem(LAUNCH_INIT_DATA_KEY, fromHash);
      sessionStorage.setItem(SDK_INIT_PARAMS_KEY, JSON.stringify(Object.fromEntries(hashParams)));
    }
    return fromHash || sessionStorage.getItem(LAUNCH_INIT_DATA_KEY) || '';
  } catch {
    return fromHash;
  }
}

const launchInitData = captureLaunchInitData();

type Status = 'loading' | 'ready' | 'outside-telegram' | 'error';

type Diagnostics = {
  sdk: 'loaded' | 'failed' | 'timeout';
  initDataSource: 'sdk' | 'url' | 'none';
  platform: string;
  rejection?: { code?: string; message: string };
};

export function TelegramProvider({
  nonce,
  botUsername,
  children,
}: {
  nonce?: string;
  botUsername: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<TelegramMe | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const initDataRef = useRef('');
  const settledRef = useRef(false);

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    // A dedicated header rather than Authorization, which reverse proxies
    // (e.g. IIS with an auth module enabled) may consume or strip.
    if (initDataRef.current) headers.set('X-Telegram-Init-Data', initDataRef.current);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const res = await fetch(path, { ...init, headers, cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new TgApiError(res.status, body?.error || `Request failed (${res.status})`, body?.code);
    return body as T;
  }, []);

  const refreshMe = useCallback(async () => {
    const latest = await api<TelegramMe>('/api/tg/me');
    setMe(latest);
    return latest;
  }, [api]);

  const settleSdk = useCallback((sdk: Diagnostics['sdk']) => {
    const wa = getWebApp();
    if (wa) {
      wa.ready();
      wa.expand();
      setWebApp(wa);
    }
    // A script that loads after the timeout only adds the native buttons.
    if (settledRef.current) return;
    settledRef.current = true;

    initDataRef.current = wa?.initData || launchInitData;
    setDiagnostics({
      sdk,
      initDataSource: wa?.initData ? 'sdk' : launchInitData ? 'url' : 'none',
      platform: wa?.platform || new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppPlatform') || 'unknown',
    });
    setSdkLoaded(true);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => settleSdk('timeout'), SDK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [settleSdk]);

  const load = useCallback(() => {
    setStatus('loading');
    refreshMe()
      .then(() => setStatus('ready'))
      .catch((e: unknown) => {
        if (e instanceof TgApiError && e.status === 401) {
          setDiagnostics(d => (d ? { ...d, rejection: { code: e.code, message: e.message } } : d));
          setStatus('outside-telegram');
        } else {
          setError(e instanceof Error ? e.message : 'Something went wrong.');
          setStatus('error');
        }
      });
  }, [refreshMe]);

  // Without initData the server only accepts the request under the local dev
  // bypass, so this also runs when the SDK fails to load.
  useEffect(() => {
    if (sdkLoaded) load();
  }, [sdkLoaded, load]);

  // A start_param deep link (t.me/<bot>/<app>?startapp=item_<id>) opens at /tg; send it on once
  // per launch. Each launch has its own initData hash, so the next deep link is not skipped.
  useEffect(() => {
    if (status !== 'ready' || !me?.startPath || pathname !== '/tg') return;
    const launchId = new URLSearchParams(initDataRef.current).get('hash') || 'dev';
    try {
      if (sessionStorage.getItem(START_HANDLED_KEY) === launchId) return;
      sessionStorage.setItem(START_HANDLED_KEY, launchId);
    } catch {
      /* storage unavailable: navigating once per load is acceptable */
    }
    router.replace(`/tg${me.startPath}`);
  }, [status, me?.startPath, pathname, router]);

  const alert = useCallback(
    (message: string) =>
      new Promise<void>(resolve => {
        if (webApp) webApp.showAlert(message, () => resolve());
        else {
          window.alert(message);
          resolve();
        }
      }),
    [webApp],
  );

  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>(resolve => {
        if (webApp) webApp.showConfirm(message, ok => resolve(Boolean(ok)));
        else resolve(window.confirm(message));
      }),
    [webApp],
  );

  const haptic = useCallback(
    (type: 'error' | 'success' | 'warning') => webApp?.HapticFeedback?.notificationOccurred(type),
    [webApp],
  );

  const linkPhone = useCallback(async () => {
    if (!webApp?.requestContact || !webApp.isVersionAtLeast('6.9')) {
      await alert('To link your phone, send /phone to the bot and tap "Share my phone number".');
      return false;
    }

    const shared = await new Promise<boolean>(resolve => webApp.requestContact!(ok => resolve(Boolean(ok))));
    if (!shared) return false;

    // The contact reaches the bot as a chat message; wait for it to be processed.
    for (let attempt = 0; attempt < LINK_POLL_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const latest = await refreshMe().catch(() => null);
      if (latest?.phoneLinked) return true;
    }
    await alert("We couldn't link that number yet. Check the bot chat for details, then try again.");
    return false;
  }, [webApp, alert, refreshMe]);

  const value = useMemo<TelegramContextValue>(
    () => ({ webApp, me, api, refreshMe, linkPhone, alert, confirm, haptic }),
    [webApp, me, api, refreshMe, linkPhone, alert, confirm, haptic],
  );

  return (
    <div className="tg-app">
      <Script
        src={SDK_SRC}
        strategy="afterInteractive"
        nonce={nonce}
        onReady={() => settleSdk('loaded')}
        onError={() => settleSdk('failed')}
      />
      {status === 'ready' ? (
        <TelegramContext.Provider value={value}>{children}</TelegramContext.Provider>
      ) : status === 'loading' ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin tg-hint" />
        </div>
      ) : status === 'outside-telegram' ? (
        <div className="mx-auto max-w-sm px-6 py-16 text-center">
          {diagnostics?.initDataSource === 'none' ? (
            <>
              <h1 className="text-lg font-semibold">Open Gebeya in Telegram</h1>
              <p className="mt-2 text-sm tg-hint">This shop runs inside the Telegram app.</p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">We couldn't verify your Telegram session</h1>
              <p className="mt-2 text-sm tg-hint">Close this window and open the shop again from the bot.</p>
            </>
          )}
          {botUsername && (
            <a className="mt-4 inline-block font-medium tg-link" href={`https://t.me/${botUsername}`}>
              Open @{botUsername}
            </a>
          )}
          {diagnostics && (
            // Shown so support can tell a blocked SDK, a stripped header and a token mismatch apart.
            <p className="mt-8 break-words text-[11px] tg-hint">
              {diagnostics.rejection?.code ?? 'UNKNOWN'} · {diagnostics.rejection?.message ?? ''} · SDK {diagnostics.sdk} · launch data{' '}
              {diagnostics.initDataSource === 'none' ? 'missing' : `from ${diagnostics.initDataSource}`} · {diagnostics.platform}
            </p>
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-sm px-6 py-16 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm tg-hint">{error}</p>
          <Button className="mt-4 tg-primary-button" onClick={load}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
