export const HeadingElement = {
  id: 'heading',
  name: 'Heading',
  icon: 'heading',
  category: 'content' as const,
  props: {
    text: { type: 'string' as const, label: 'Heading Text', required: true, defaultValue: 'Heading' },
    level: {
      type: 'select' as const,
      label: 'Heading Level',
      defaultValue: 'h2',
      options: [
        { label: 'H1', value: 'h1' },
        { label: 'H2', value: 'h2' },
        { label: 'H3', value: 'h3' },
        { label: 'H4', value: 'h4' },
      ]
    },
    alignment: {
      type: 'select' as const,
      label: 'Alignment',
      defaultValue: 'left',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
      ]
    },
  },
  defaults: {
    text: 'Heading',
    level: 'h2',
    alignment: 'left',
  },
};
