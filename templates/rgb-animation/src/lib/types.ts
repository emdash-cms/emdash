export interface WorkItem {
  id: string;
  slug: string;
  title: string;
  titleEn: string;
  category: 'film' | 'game' | 'video' | 'background' | 'character' | 'tvc';
  thumbnail: string;
  year: number;
  description: string;
  descriptionEn: string;
}

export interface ProjectItem {
  id: string;
  slug: string;
  title: string;
  titleEn: string;
  thumbnail: string;
  summary: string;
  summaryEn: string;
  status: 'ongoing' | 'completed';
}

export interface OutsourcedItem {
  id: string;
  title: string;
  titleEn: string;
  mediaType: 'image' | 'video';
  src: string;
  aspectRatio: 'landscape' | 'portrait' | 'square';
  category: string;
}

export interface CarouselImage {
  id: string;
  src: string;
  alt: string;
  altEn: string;
}
