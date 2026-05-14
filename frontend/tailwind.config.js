/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: {
          900: '#0f172a',
          800: '#1e293b',
          700: '#334155',
          600: '#475569',
        },
        gold: {
          500: '#f59e0b',
          400: '#fbbf24',
          600: '#d97706',
          300: '#fcd34d',
        },
      },
    },
  },
  plugins: [],
}
