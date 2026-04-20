import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#102033",
        cloud: "#f6f9fd",
        blueglass: "#eaf4ff",
        honey: "#f8c56a",
      },
      boxShadow: {
        soft: "0 22px 70px rgba(44, 83, 132, 0.12)",
        card: "0 18px 50px rgba(44, 83, 132, 0.10)",
        lift: "0 24px 70px rgba(37, 99, 235, 0.18)",
      },
    },
  },
  plugins: [],
};

export default config;
