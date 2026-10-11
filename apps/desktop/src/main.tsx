import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Pill } from "./Pill";
import { useJarvis } from "./useJarvis";
import "./styles.css";

function App() {
  return <Pill jarvis={useJarvis()} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
