/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        priority: {
          high: '#ef4444',
          medium: '#f59e0b',
          low: '#71717a',
        },
      },
    },
  },
  plugins: [],
}
