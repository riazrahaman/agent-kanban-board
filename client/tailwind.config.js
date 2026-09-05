/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        line: 'var(--line)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        'muted-bg': 'var(--muted-bg)',
        pass: 'var(--pass)',
        'pass-bg': 'var(--pass-bg)',
        fail: 'var(--fail)',
        'fail-bg': 'var(--fail-bg)',
        warn: 'var(--warn)',
        'warn-bg': 'var(--warn-bg)',
        block: 'var(--block)',
        'block-bg': 'var(--block-bg)',
        live: 'var(--live)',
        'live-bg': 'var(--live-bg)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
        serif: ['Instrument Serif', 'Georgia', 'Times New Roman', 'serif'],
      },
    },
  },
  plugins: [],
}
