export const TextElement = {
  id: 'text',
  name: 'Text',
  icon: 'text',
  category: 'content' as const,
  props: {
    content: { type: 'content' as const, label: 'Text Content', required: true },
    fontSize: {
      type: 'select' as const,
      label: 'Font Size',
      defaultValue: 'medium',
      options: [
        { label: 'Small', value: 'small' },
        { label: 'Medium', value: 'medium' },
        { label: 'Large', value: 'large' },
        { label: 'Extra Large', value: 'xlarge' },
      ]
    },
    textColor: { type: 'color' as const, label: 'Text Color', defaultValue: '#1f2a24' },
  },
  defaults: {
    content: 'Enter text here',
    fontSize: 'medium',
    textColor: '#1f2a24',
  },
};
