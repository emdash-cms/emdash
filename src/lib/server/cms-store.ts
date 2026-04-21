import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { defaultCmsData, type CmsData } from '$lib/cms-schema';

const cmsPath = resolve(process.cwd(), 'data', 'cms.json');

export async function readCmsData(): Promise<CmsData> {
  try {
    const raw = await readFile(cmsPath, 'utf8');
    return JSON.parse(raw) as CmsData;
  } catch {
    return defaultCmsData;
  }
}

export async function writeCmsData(data: CmsData): Promise<void> {
  await mkdir(dirname(cmsPath), { recursive: true });
  await writeFile(cmsPath, JSON.stringify(data, null, 2), 'utf8');
}
