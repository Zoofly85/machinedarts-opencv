import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { getFlavorConfig } from "./config/productFlavor";

const flavor = getFlavorConfig();
document.title = flavor.productName;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
