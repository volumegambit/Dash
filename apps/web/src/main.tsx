import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppRoot } from './AppRoot.js';
import { config } from './config.js';

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppRoot clerkPublishableKey={config.clerkPublishableKey} />
    </React.StrictMode>,
  );
}
