/**
 * SPA entry point. Mounts `<App />` into `#root` from `index.html` and pulls in the global
 * Tailwind stylesheet. Nothing else lives here — all application wiring is in `App.tsx`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
