import { ClerkProvider } from '@clerk/clerk-react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { config } from './config.js';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ClerkProvider publishableKey={config.clerkPublishableKey}>
        <App />
      </ClerkProvider>
    </React.StrictMode>,
  );
}
