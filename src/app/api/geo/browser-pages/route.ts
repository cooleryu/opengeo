import { NextRequest, NextResponse } from 'next/server';
import { requireBrowserCollectionRequest, BrowserCollectionError } from '@/lib/geo/browser-collection';
import { GeoProjectError } from '@/lib/geo/projects';
import { PageReadingError, readSearchPage } from '@/lib/geo/page-reader';
import { GeoSettingsError } from '@/lib/geo/connection-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/** The local browser collector sends what the page shows; the AI page reader says what it is. */
export async function POST(request: NextRequest) {
  try {
    requireBrowserCollectionRequest(request, true);
    const body = await request.text();
    if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new PageReadingError('The page capture is larger than 2 MiB.', 413);
    return response(await readSearchPage(JSON.parse(body)));
  } catch (error) {
    if (error instanceof PageReadingError || error instanceof BrowserCollectionError || error instanceof GeoProjectError) {
      return response({ error: error.message }, error.status);
    }
    if (error instanceof GeoSettingsError) return response({ error: 'No AI model is set up for reading pages.', code: error.code }, error.status);
    return response({ error: error instanceof SyntaxError ? 'The request is not valid JSON.' : 'The page could not be read.' },
      error instanceof SyntaxError ? 400 : 500);
  }
}
