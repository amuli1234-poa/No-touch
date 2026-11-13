import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './lib/hooks';
import { Toaster } from './components/UI';
import './styles/theme.css';

/**
 * WickSentinel Admin entry point. A standalone application: it mounts into its
 * own root element and talks only to the admin API namespace.
 */
const container = document.getElementById('admin-root');
if (!container) throw new Error('Admin root element not found');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <AuthProvider>
        <App />
        <Toaster />
      </AuthProvider>
    </ToastProvider>
  </StrictMode>
);
