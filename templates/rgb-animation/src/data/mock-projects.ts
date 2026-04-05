import type { ProjectItem } from '@/lib/types';

export const mockProjects: ProjectItem[] = [
  {
    id: 'p1',
    slug: 'rgb-origins',
    title: 'RGB Origins',
    titleEn: 'RGB Origins',
    thumbnail: '/images/placeholder-project-1.svg',
    summary: 'RGB Animationの設立ストーリーを描くオリジナルアニメーション企画。',
    summaryEn: 'Original animation project depicting the founding story of RGB Animation.',
    status: 'ongoing',
  },
  {
    id: 'p2',
    slug: 'color-spectrum',
    title: 'カラースペクトラム',
    titleEn: 'Color Spectrum',
    thumbnail: '/images/placeholder-project-2.svg',
    summary: '色彩をテーマにした実験的ショートフィルムシリーズ。',
    summaryEn: 'Experimental short film series themed around color.',
    status: 'ongoing',
  },
  {
    id: 'p3',
    slug: 'digital-frontier',
    title: 'デジタルフロンティア',
    titleEn: 'Digital Frontier',
    thumbnail: '/images/placeholder-project-3.svg',
    summary: 'VR技術を活用した次世代映像体験プロジェクト。',
    summaryEn: 'Next-gen visual experience project utilizing VR technology.',
    status: 'completed',
  },
];
