import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        msb: {
          orange: "#F58220",
          "orange-dark": "#E06F12",
          cream: "#FFF6ED",
          ink: "#2A2118",
          mist: "#FFF1E4",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
