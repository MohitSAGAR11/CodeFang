import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./components/Landing.tsx";
import { loadFonts } from "./lib/fonts.ts";

loadFonts();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Landing />
    </StrictMode>,
  );
}
