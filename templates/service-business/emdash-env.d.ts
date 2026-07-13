/// <reference types="emdash/locals" />

import type { PortableTextBlock } from "emdash";

interface BaseEntry { id: string; slug: string | null; status: string; createdAt: Date; updatedAt: Date; publishedAt: Date | null }
interface Service extends BaseEntry { title: string; short_description?: string; description?: PortableTextBlock[]; icon?: string; starting_price?: string; featured?: boolean }
interface Project extends BaseEntry { title: string; service?: string; location?: string; summary?: string; gallery?: { src: string; alt: string }[]; result?: string }
interface Review extends BaseEntry { customer_name: string; quote: string; rating?: number; service?: string; location?: string }
interface Faq extends BaseEntry { question: string; answer: string; category?: string }
interface ServiceArea extends BaseEntry { name: string; region?: string; description?: string }
interface TeamMember extends BaseEntry { name: string; role: string; bio?: string; years_experience?: number }
interface Certificate extends BaseEntry { name: string; issuer?: string; credential?: string; logo_text?: string }
interface BusinessSettings extends BaseEntry { business_name: string; phone: string; email: string; street_address?: string; city?: string; region?: string; postal_code?: string; opening_hours?: string; price_range?: string; hero_heading?: string; hero_text?: string; primary_cta_label?: string; primary_cta_url?: string }

declare module "emdash" {
	interface EmDashCollections {
		services: Service;
		projects: Project;
		reviews: Review;
		faqs: Faq;
		service_areas: ServiceArea;
		team: TeamMember;
		certificates: Certificate;
		business_settings: BusinessSettings;
	}
}
