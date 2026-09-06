import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './app/styles/tokens.css';
import './app/styles/base.css';
import './app/styles/components.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
