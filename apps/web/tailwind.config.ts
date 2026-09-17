import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        msb: {
          orange: "#F15A22",
          "orange-dark": "#D44512",
          "orange-deep": "#C7370F",
          cream: "#FFF3EC",
          ink: "#1C1410",
          mist: "#FFE8DA",
          surface: "#F6F6F6",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
