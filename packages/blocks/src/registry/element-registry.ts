export interface ElementDefinition {
  id: string;
  name: string;
  icon?: string;
  category: 'content' | 'layout' | 'media' | 'social';
  props: Record<string, PropDefinition>;
  defaults?: Record<string, any>;
}

export interface PropDefinition {
  type: 'string' | 'number' | 'boolean' | 'select' | 'media' | 'color' | 'content';
  label: string;
  defaultValue?: any;
  options?: { label: string; value: any }[];
  required?: boolean;
}

class ElementRegistry {
  private elements = new Map<string, ElementDefinition>();

  register(definition: ElementDefinition): void {
    if (this.elements.has(definition.id)) {
      console.warn(`Element ${definition.id} already registered, skipping`);
      return;
    }
    this.elements.set(definition.id, definition);
  }

  unregister(id: string): boolean {
    return this.elements.delete(id);
  }

  get(id: string): ElementDefinition | undefined {
    return this.elements.get(id);
  }

  getAll(): ElementDefinition[] {
    return [...this.elements.values()];
  }

  getByCategory(category: ElementDefinition['category']): ElementDefinition[] {
    return this.getAll().filter(el => el.category === category);
  }

  has(id: string): boolean {
    return this.elements.has(id);
  }

  clear(): void {
    this.elements.clear();
  }
}

export const elementRegistry = new ElementRegistry();
export { ElementRegistry };
