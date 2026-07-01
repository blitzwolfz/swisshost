import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { CONFIG } from './config.js';
import './styles.css';

// --- Single source of truth for color: inject config tokens into CSS vars. ---
function applyThemeTokens() {
  const root = document.documentElement.style;
  const c = CONFIG.colors;
  root.setProperty('--sh-cream', c.cream);
  root.setProperty('--sh-paper', c.paper);
  root.setProperty('--sh-ink', c.ink);
  root.setProperty('--sh-red', c.red);
  root.setProperty('--sh-red-dark', c.redDark);
  root.setProperty('--sh-muted', c.muted);
  root.setProperty('--sh-line', c.line);
  root.setProperty('--sh-ok', c.ok);
  root.setProperty('--sh-warn', c.warn);
  document.title = `${CONFIG.siteName} — P2P encrypted file sharing & chat`;
}

// --- Detect TV browsers to enable the 10-foot UI (html.tv). ---
function detectTv() {
  const ua = navigator.userAgent || '';
  const isTv =
    /Tizen|Web0S|webOS|SMART-TV|SmartTV|HbbTV|NetCast|BRAVIA|AFT|GoogleTV|Android TV|CrKey/i.test(
      ua
    ) || window.matchMedia('(min-width: 1920px) and (min-height: 1080px)').matches;
  if (isTv) document.documentElement.classList.add('tv');
}

applyThemeTokens();
detectTv();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
