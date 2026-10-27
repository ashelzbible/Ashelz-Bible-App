import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/screens.css';
import { App } from './App.tsx';
import { applyStoredAppearance } from './lib/theme.ts';

applyStoredAppearance();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
