import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/layout.css';
import '../styles/screens.css';
import './demo.css';
import { App } from '../App.tsx';
import { authenticate } from '../lib/actions.ts';
import { applyAppearance } from '../lib/theme.ts';
import { installDemoBackend } from './backend.ts';

(window as any).__WZ_DEMO__ = true;
installDemoBackend();
applyAppearance(undefined);
const root = document.getElementById('root')!;
(async () => {
  // Sign in as the demo user before the first render so the app opens straight into the chats.
  try { await authenticate('/api/auth/login', { identifier: 'alex', password: 'demo' }); } catch { /* the login screen still works with any input */ }
  createRoot(root).render(<><div className="demo-ribbon" role="note"><b>Interactive demo</b><span>Everything runs in this page and resets on reload. Contacts reply automatically. Calls, voice recording and sync need the real server.</span></div><App /></>);
})();
