import type { Config } from 'tailwindcss';
import type { DefaultColors } from 'tailwindcss/types/generated/colors';
import typography from '@tailwindcss/typography';
import headlessUi from '@headlessui/tailwindcss';

const themeDark = (colors: DefaultColors) => ({
  50: '#0d1117',
  100: '#161b22',
  200: '#21262d',
  300: '#30363d',
});

const themeLight = (colors: DefaultColors) => ({
  50: '#ffffff',
  100: '#f6f8fa',
  200: '#e8edf1',
  300: '#d0d7de',
});

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      borderColor: ({ colors }) => {
        return {
          light: themeLight(colors),
          dark: themeDark(colors),
        };
      },
      colors: ({ colors }) => {
        const colorsDark = themeDark(colors);
        const colorsLight = themeLight(colors);

        return {
          dark: {
            primary: colorsDark[50],
            secondary: colorsDark[100],
            ...colorsDark,
          },
          light: {
            primary: colorsLight[50],
            secondary: colorsLight[100],
            ...colorsLight,
          },
        };
      },
    },
  },
  plugins: [
    typography,
    headlessUi({ prefix: 'headless' }),
  ],
};
export default config;
