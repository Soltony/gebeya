'use client';

import { useEffect } from 'react';
import { useTelegram } from './telegram-provider';
import { BRAND_BUTTON } from './webapp';

/** Shows Telegram's native back button while `onBack` is set. */
export function useBackButton(onBack: (() => void) | null) {
  const { webApp } = useTelegram();
  useEffect(() => {
    const button = webApp?.BackButton;
    if (!button) return;
    if (!onBack) {
      button.hide();
      return;
    }
    button.onClick(onBack);
    button.show();
    return () => {
      button.offClick(onBack);
      button.hide();
    };
  }, [webApp, onBack]);
}

/**
 * Drives Telegram's native bottom button. Returns false outside Telegram
 * (local dev), where the screen should render its own button instead.
 */
export function useMainButton({
  text,
  visible,
  enabled = true,
  progress = false,
  onClick,
}: {
  text: string;
  visible: boolean;
  enabled?: boolean;
  progress?: boolean;
  onClick: () => void;
}): boolean {
  const { webApp } = useTelegram();

  useEffect(() => {
    const button = webApp?.MainButton;
    if (!button) return;
    button.onClick(onClick);
    return () => button.offClick(onClick);
  }, [webApp, onClick]);

  useEffect(() => {
    const button = webApp?.MainButton;
    if (!button) return;
    button.setParams({ ...BRAND_BUTTON, text, is_visible: visible, is_active: enabled && !progress });
    if (progress) button.showProgress(false);
    else button.hideProgress();
  }, [webApp, text, visible, enabled, progress]);

  useEffect(() => () => webApp?.MainButton.hide(), [webApp]);

  return Boolean(webApp);
}
