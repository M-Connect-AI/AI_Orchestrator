import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function appleAppSiteAssociationMime(): Plugin {
  const setJsonHeader = (
    req: { url?: string },
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ) => {
    if (req.url?.split("?")[0] === "/.well-known/apple-app-site-association") {
      res.setHeader("Content-Type", "application/json");
    }
    next();
  };

  return {
    name: "apple-app-site-association-mime",
    configureServer(server) {
      server.middlewares.use(setJsonHeader);
    },
    configurePreviewServer(server) {
      server.middlewares.use(setJsonHeader);
    },
  };
}

export default defineConfig({
  plugins: [react(), appleAppSiteAssociationMime()],
  server: {
    port: 5173,
  },
});
