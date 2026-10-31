import { handleConnectionTestRequest } from '@/lib/geo/connection-test';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleConnectionTestRequest(request);
}
