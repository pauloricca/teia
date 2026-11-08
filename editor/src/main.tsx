import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '@pauloricca/spagbol/styles.css';
import { App } from './App';
import { installDiagnostics } from './diagnostics';
import './themes.css';
import './styles.css';

installDiagnostics();

const theme = import.meta.env.VITE_TEIA_THEME?.trim();
if (theme) {
  document.documentElement.dataset.theme = theme;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
