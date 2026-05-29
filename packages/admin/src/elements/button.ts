export const ButtonElement = {
  id: 'button',
  name: 'Button',
  icon: 'button',
  category: 'content' as const,
  props: {
    text: { type: 'string' as const, label: 'Button Text', required: true, defaultValue: 'Click me' },
    url: { type: 'string' as const, label: 'Link URL', defaultValue: '#' },
    variant: {
      type: 'select' as const,
      label: 'Variant',
      defaultValue: 'primary',
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Secondary', value: 'secondary' },
        { label: 'Outline', value: 'outline' },
      ]
    },
    size: {
      type: 'select' as const,
      label: 'Size',
      defaultValue: 'medium',
      options: [
        { label: 'Small', value: 'small' },
        { label: 'Medium', value: 'medium' },
        { label: 'Large', value: 'large' },
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
    text: 'Click me',
    url: '#',
    variant: 'primary',
    size: 'medium',
    alignment: 'left',
  },
};
