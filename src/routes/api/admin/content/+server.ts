import { json } from '@sveltejs/kit';

import { readCmsData, writeCmsData } from '$lib/server/cms-store';

export async function GET() {
  return json(await readCmsData());
}

export async function PUT({ request }) {
  const payload = await request.json();
  await writeCmsData(payload);
  return json({ ok: true });
}
