import { NextRequest, NextResponse } from 'next/server';
import { getItemImage, ITEM_IMAGE_WIDTHS, type ItemImageWidth } from '@/lib/marketplace/item-images';

/**
 * GET /api/marketplace/items/:id/images/:index?w=400&v=<updatedAt>
 *
 * One product photo of an active item, resized to an allowed width. Public on
 * purpose: these are the same catalog photos /api/shop already returns, and
 * <img> tags cannot send the Mini App's auth header. With `v` the response is
 * cached for a year — the version changes whenever the item does.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  try {
    const { id, index } = await params;
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position > 50) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const requested = Number(searchParams.get('w'));
    const width = (ITEM_IMAGE_WIDTHS as readonly number[]).includes(requested) ? (requested as ItemImageWidth) : 400;
    const cacheControl = searchParams.get('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';

    const image = await getItemImage(id, position, width);
    if (!image) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (image.kind === 'redirect') {
      return NextResponse.redirect(image.url, { status: 302 });
    }

    if (req.headers.get('if-none-match') === image.etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: image.etag, 'Cache-Control': cacheControl } });
    }

    return new NextResponse(new Uint8Array(image.body), {
      headers: {
        'Content-Type': image.contentType,
        'Content-Length': String(image.body.length),
        'Cache-Control': cacheControl,
        ETag: image.etag,
      },
    });
  } catch (error) {
    console.error('[api/marketplace/items/images]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
