import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "dust-purple": {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#8B5CF6",
          600: "#7c3aed",
          700: "#6d28d9",
          800: "#5b21b6",
          900: "#4c1d95",
          950: "#2e1065",
          DEFAULT: "#8B5CF6",
        },
        "dust-blue": {
          50: "#eef2ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366F1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81",
          950: "#1e1b4b",
          DEFAULT: "#6366F1",
        },
        surface: {
          DEFAULT: "#0a0a0f",
          50: "#18181f",
          100: "#1e1e2a",
          200: "#252535",
          300: "#2d2d40",
          400: "#35354b",
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "dust-gradient":
          "linear-gradient(135deg, #8B5CF6 0%, #6366F1 50%, #3B82F6 100%)",
        "dust-gradient-subtle":
          "linear-gradient(135deg, rgba(139,92,246,0.1) 0%, rgba(99,102,241,0.1) 50%, rgba(59,130,246,0.1) 100%)",
        "card-gradient":
          "linear-gradient(180deg, rgba(139,92,246,0.05) 0%, rgba(99,102,241,0.02) 100%)",
      },
      boxShadow: {
        dust: "0 0 20px rgba(139, 92, 246, 0.15)",
        "dust-lg": "0 0 40px rgba(139, 92, 246, 0.2)",
        "dust-glow": "0 0 60px rgba(139, 92, 246, 0.3)",
        card: "0 4px 24px rgba(0, 0, 0, 0.3)",
        "card-hover": "0 8px 40px rgba(0, 0, 0, 0.4)",
      },
      animation: {
        "dust-float-1": "dustFloat1 20s ease-in-out infinite",
        "dust-float-2": "dustFloat2 25s ease-in-out infinite",
        "dust-float-3": "dustFloat3 30s ease-in-out infinite",
        "dust-float-4": "dustFloat4 22s ease-in-out infinite",
        "dust-float-5": "dustFloat5 28s ease-in-out infinite",
        "dust-float-6": "dustFloat6 18s ease-in-out infinite",
        shimmer: "shimmer 2s linear infinite",
        "fade-in": "fadeIn 0.5s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
        "pulse-soft": "pulseSoft 3s ease-in-out infinite",
      },
      keyframes: {
        dustFloat1: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)", opacity: "0.3" },
          "25%": { transform: "translate(100px, -150px) scale(1.2)", opacity: "0.5" },
          "50%": { transform: "translate(-50px, -300px) scale(0.8)", opacity: "0.2" },
          "75%": { transform: "translate(80px, -150px) scale(1.1)", opacity: "0.4" },
        },
        dustFloat2: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)", opacity: "0.2" },
          "33%": { transform: "translate(-120px, -200px) scale(1.3)", opacity: "0.4" },
          "66%": { transform: "translate(60px, -350px) scale(0.7)", opacity: "0.15" },
        },
        dustFloat3: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)", opacity: "0.25" },
          "20%": { transform: "translate(80px, -100px) scale(1.1)", opacity: "0.35" },
          "40%": { transform: "translate(-40px, -250px) scale(0.9)", opacity: "0.2" },
          "60%": { transform: "translate(120px, -180px) scale(1.2)", opacity: "0.4" },
          "80%": { transform: "translate(-60px, -320px) scale(0.85)", opacity: "0.15" },
        },
        dustFloat4: {
          "0%, 100%": { transform: "translate(0, 0) rotate(0deg)", opacity: "0.3" },
          "50%": { transform: "translate(-90px, -280px) rotate(180deg)", opacity: "0.5" },
        },
        dustFloat5: {
          "0%, 100%": { transform: "translate(0, 0) scale(1)", opacity: "0.2" },
          "30%": { transform: "translate(150px, -120px) scale(1.4)", opacity: "0.45" },
          "70%": { transform: "translate(-80px, -300px) scale(0.6)", opacity: "0.1" },
        },
        dustFloat6: {
          "0%, 100%": { transform: "translate(0, 0) scale(0.8)", opacity: "0.15" },
          "40%": { transform: "translate(-110px, -200px) scale(1.2)", opacity: "0.35" },
          "80%": { transform: "translate(40px, -350px) scale(0.9)", opacity: "0.2" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(20px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
    },
  },
  plugins: [],
};

export default config;