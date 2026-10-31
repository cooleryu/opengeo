import nextVitals from 'eslint-config-next/core-web-vitals';

export default [
  ...nextVitals,
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'JSXOpeningElement[name.type="JSXIdentifier"][name.name="select"]',
          message:
            'OpenGEO 不使用原生 <select>。请复用 src/components/geo/GeoSelect.tsx，保持下拉菜单样式一致。',
        },
      ],
    },
  },
];
