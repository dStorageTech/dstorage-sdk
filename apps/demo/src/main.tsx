// Polyfill Buffer globally before any other code runs.
// Lace wallet injects window.Buffer, but other wallets (e.g. 1AM) do not.
// compact-runtime uses Buffer as a global, so without this it throws
// "ReferenceError: Buffer is not defined" during contract execution.
import { Buffer } from "buffer";
const globalWithBuffer = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
};
if (typeof globalWithBuffer.Buffer === "undefined") {
  globalWithBuffer.Buffer = Buffer;
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
