/**
 * Item photos are stored in the database as base64 data URLs (Item.imageUrl,
 * a JSON array), at whatever size the merchant uploaded. Shipping them inside
 * JSON makes every catalog request carry every photo at full size, uncached.
 * This serves each photo from its own URL instead, resized for phones and
 * cacheable: the URL carries the item's updatedAt, so it changes whenever the
 * item (and therefore possibly its photos) changes.
 */
import prisma from '@/lib/prisma';
import { parseItemImages } from './catalog';

/** Widths the image route will produce: grid thumbnails, detail thumbnails, detail view. */
export const ITEM_IMAGE_WIDTHS = [200, 400, 960] as const;
export type ItemImageWidth = (typeof ITEM_IMAGE_WIDTHS)[number];

export function itemImageUrl(itemId: string, index: number, updatedAt: Date, width: ItemImageWidth): string {
  return `/api/marketplace/items/${encodeURIComponent(itemId)}/images/${index}?w=${width}&v=${updatedAt.getTime()}`;
}

export type ItemImage =
  | { kind: 'bytes'; body: Buffer; contentType: string; etag: string }
  | { kind: 'redirect'; url: string };

// Processed images, keyed by item/index/width/version. Versioned keys never go
// stale, so the only concern is memory: keep the most recent entries.
const cache = new Map<string, ItemImage>();
const CACHE_MAX_ENTRIES = 300;

function remember(key: string, image: ItemImage) {
  cache.delete(key);
  cache.set(key, image);
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

// Raster formats only: an SVG served from our own origin could carry script.
const SERVABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif']);

function decodeDataUrl(value: string): { contentType: string; body: Buffer } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(value);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  if (!SERVABLE_TYPES.has(contentType)) return null;
  return { contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType, body: Buffer.from(match[2], 'base64') };
}

async function resize(body: Buffer, width: number): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    // sharp ships with Next.js (optional dependency); without it, originals are served.
    const { default: sharp } = await import('sharp');
    const out = await sharp(body).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    return { body: out, contentType: 'image/webp' };
  } catch (error) {
    console.warn('[item-images] resize unavailable, serving original', String(error));
    return null;
  }
}

/** The photo at `index` of an active item, or null if there is none. */
export async function getItemImage(itemId: string, index: number, width: ItemImageWidth): Promise<ItemImage | null> {
  // Check the version first so a cache hit never reads the (large) imageUrl column.
  const item = await prisma.item.findFirst({
    where: { id: itemId, status: 'ACTIVE', merchant: { status: 'ACTIVE' } },
    select: { updatedAt: true },
  });
  if (!item) return null;

  const key = `${itemId}:${index}:${width}:${item.updatedAt.getTime()}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const media = await prisma.item.findUnique({ where: { id: itemId }, select: { imageUrl: true } });
  const source = parseItemImages(media?.imageUrl)[index];
  if (!source) return null;

  let image: ItemImage | null;
  if (/^https?:\/\//i.test(source)) {
    image = { kind: 'redirect', url: source };
  } else {
    const decoded = decodeDataUrl(source);
    if (!decoded) return null;
    const final = (await resize(decoded.body, width)) ?? decoded;
    image = { kind: 'bytes', body: final.body, contentType: final.contentType, etag: `"${key}"` };
  }

  remember(key, image);
  return image;
}
