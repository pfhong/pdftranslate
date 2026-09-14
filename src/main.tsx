import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// pdf.js 文本选择层的官方样式（.textLayer 定位规则）
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
