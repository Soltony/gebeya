'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ShoppingBag, Package } from 'lucide-react';

const TABS = [
  { href: '/tg', label: 'Shop', icon: ShoppingBag },
  { href: '/tg/orders', label: 'My orders', icon: Package },
];

/** Top-level navigation between the shop and the customer's orders. */
export function TgTabs() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-10 flex gap-2 px-4 pb-2 pt-3" style={{ background: 'var(--tg-secondary-bg)' }}>
      {TABS.map(tab => {
        const active = tab.href === '/tg' ? pathname === '/tg' : pathname.startsWith(tab.href);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            data-active={active}
            className="tg-chip flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-medium"
          >
            <Icon className="h-4 w-4" />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
