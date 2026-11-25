import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChartPage } from "./ChartPage.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root application element");

createRoot(rootElement).render(
  <StrictMode>
    <ChartPage />
  </StrictMode>
);
