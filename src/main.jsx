import React from "react";
import ReactDOM from "react-dom/client";
import { inject, track } from "@vercel/analytics";
import App from "./App.jsx";

// Vercel Web Analytics. App.jsx stays dependency-free (it also runs as a
// claude.ai artifact), so it reaches analytics only via this global.
inject({ mode: import.meta.env.PROD ? "production" : "development" });
window.__csTrack = track;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
