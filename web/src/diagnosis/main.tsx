import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { DiagnosisApp } from './App';
import '../styles/globals.css';
import './styles.css';

document.documentElement.classList.add('diagnosis-app');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <DiagnosisApp />
    </HashRouter>
  </StrictMode>,
);
