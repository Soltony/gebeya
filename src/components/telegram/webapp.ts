/**
 * The parts of window.Telegram.WebApp (telegram-web-app.js) the Mini App uses.
 * https://core.telegram.org/bots/webapps#initializing-mini-apps
 */

type ButtonParams = {
  text?: string;
  color?: string;
  text_color?: string;
  is_active?: boolean;
  is_visible?: boolean;
};

export type TelegramWebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  isVersionAtLeast(version: string): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  MainButton: {
    setParams(params: ButtonParams): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  HapticFeedback?: {
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  showAlert(message: string, callback?: () => void): void;
  showConfirm(message: string, callback?: (confirmed: boolean) => void): void;
  requestContact?(callback?: (shared: boolean) => void): void;
  openTelegramLink(url: string): void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const webApp = window.Telegram?.WebApp;
  // The SDK also defines WebApp in a normal browser; it is only real inside Telegram.
  return webApp && webApp.platform !== 'unknown' ? webApp : null;
}

/** Brand yellow, matching the super-app shop buttons. */
export const BRAND_BUTTON = { color: '#fdb913', text_color: '#000000' };
